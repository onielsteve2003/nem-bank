package console

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/admin"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/console/consoledb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/pagination"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// The ledger explorer reads the ledger's own tables (ADM-7). It never writes: the only way staff
// change the ledger is a manual adjustment, and that posts through the posting engine after a
// second staff member approved it.

func apiMoney(minor int64, currency string) api.Money {
	return accounts.Money(money.New(minor, money.Currency(currency)))
}

func firstPage(c pagination.Cursor, newestFirst bool) pagination.Cursor {
	if !c.IsZero() {
		return c
	}
	if newestFirst {
		return pagination.Cursor{Time: time.Now().Add(24 * time.Hour), ID: uuid.Max}
	}
	return pagination.Cursor{Time: time.Unix(0, 0).UTC(), ID: uuid.Nil}
}

// dateRange turns the contract's inclusive from/to dates into [from, to+1d). Missing means
// everything.
func dateRange(from, to *time.Time) (time.Time, time.Time) {
	lo, hi := time.Unix(0, 0).UTC(), time.Now().UTC().Add(24*time.Hour)
	if from != nil {
		lo = time.Date(from.Year(), from.Month(), from.Day(), 0, 0, 0, 0, time.UTC)
	}
	if to != nil {
		hi = time.Date(to.Year(), to.Month(), to.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, 1)
	}
	return lo, hi
}

// LedgerAccounts lists ledger accounts, oldest first.
func (s *Service) LedgerAccounts(ctx context.Context, p api.ListLedgerAccountsParams) ([]api.LedgerAccount, api.PageInfo, error) {
	if _, err := staff(ctx); err != nil {
		return nil, api.PageInfo{}, err
	}
	after, err := pagination.Decode(p.Cursor)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	after = firstPage(after, false)
	n := pagination.Limit(p.Limit)
	args := consoledb.ListLedgerAccountsParams{AfterTime: after.Time, AfterID: after.ID, PageSize: int32(n + 1)} //nolint:gosec // n is at most 100
	if p.OwnerType != nil {
		args.OwnerType = string(*p.OwnerType)
	}
	if p.OwnerId != nil {
		args.OwnerID = *p.OwnerId
	}
	if p.Currency != nil {
		args.Currency = string(*p.Currency)
	}
	rows, err := s.q.ListLedgerAccounts(ctx, args)
	if err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("list ledger accounts: %w", err)
	}
	rows, page := pagination.Page(rows, n, func(r consoledb.LedgerAccount) pagination.Cursor {
		return pagination.Cursor{Time: r.CreatedAt, ID: r.ID}
	})
	out := make([]api.LedgerAccount, len(rows))
	for i, r := range rows {
		out[i] = api.LedgerAccount{
			Id: r.ID, OwnerType: api.LedgerOwnerType(r.OwnerType), OwnerId: r.OwnerID, Kind: api.LedgerAccountKind(r.Kind),
			Currency: api.CurrencyCode(r.Currency), Name: &r.Name, Balance: apiMoney(r.BalanceMinor, r.Currency),
			Available: apiMoney(r.AvailableMinor, r.Currency), Version: int(r.Version), CreatedAt: r.CreatedAt.UTC(),
		}
	}
	return out, page, nil
}

func postingOf(r consoledb.Posting) api.Posting {
	after := apiMoney(r.BalanceAfterMinor, r.Currency)
	return api.Posting{Id: r.ID, EntryId: r.EntryID, AccountId: r.AccountID, Amount: apiMoney(r.AmountMinor, r.Currency), BalanceAfter: &after, CreatedAt: r.CreatedAt.UTC()}
}

// LedgerPostings lists the postings on one account, newest first.
func (s *Service) LedgerPostings(ctx context.Context, id uuid.UUID, p api.ListLedgerPostingsParams) ([]api.Posting, api.PageInfo, error) {
	if _, err := staff(ctx); err != nil {
		return nil, api.PageInfo{}, err
	}
	ok, err := s.q.LedgerAccountExists(ctx, id)
	if err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("check account: %w", err)
	}
	if !ok {
		return nil, api.PageInfo{}, problem.NotFound("Ledger account")
	}
	after, err := pagination.Decode(p.Cursor)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	after = firstPage(after, true)
	var from, to *time.Time
	if p.From != nil {
		from = &p.From.Time
	}
	if p.To != nil {
		to = &p.To.Time
	}
	lo, hi := dateRange(from, to)
	n := pagination.Limit(p.Limit)
	rows, err := s.q.ListLedgerPostings(ctx, consoledb.ListLedgerPostingsParams{
		AccountID: id, FromTime: lo, ToTime: hi, AfterTime: after.Time, AfterID: after.ID, PageSize: int32(n + 1), //nolint:gosec // n is at most 100
	})
	if err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("list postings: %w", err)
	}
	rows, page := pagination.Page(rows, n, func(r consoledb.Posting) pagination.Cursor {
		return pagination.Cursor{Time: r.CreatedAt, ID: r.ID}
	})
	out := make([]api.Posting, len(rows))
	for i, r := range rows {
		out[i] = postingOf(r)
	}
	return out, page, nil
}

type entryRow struct {
	ID             uuid.UUID
	Kind           string
	Reference      string
	IdempotencyKey *string
	ApprovalID     *uuid.UUID
	Metadata       []byte
	CreatedAt      time.Time
}

func (s *Service) entriesJSON(ctx context.Context, rows []entryRow) ([]api.JournalEntry, error) {
	ids := make([]uuid.UUID, len(rows))
	for i, r := range rows {
		ids[i] = r.ID
	}
	posts, err := s.q.ListEntryPostings(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("list entry postings: %w", err)
	}
	byEntry := map[uuid.UUID][]api.Posting{}
	for _, p := range posts {
		byEntry[p.EntryID] = append(byEntry[p.EntryID], postingOf(p))
	}
	out := make([]api.JournalEntry, len(rows))
	for i, r := range rows {
		meta := map[string]any{}
		if len(r.Metadata) > 0 {
			if err := jsonUnmarshal(r.Metadata, &meta); err != nil {
				return nil, fmt.Errorf("decode entry metadata: %w", err)
			}
		}
		out[i] = api.JournalEntry{
			Id: r.ID, Kind: api.JournalEntryKind(r.Kind), Reference: r.Reference, IdempotencyKey: r.IdempotencyKey,
			Postings: byEntry[r.ID], Metadata: meta, ApprovalId: r.ApprovalID, CreatedAt: r.CreatedAt.UTC(),
		}
	}
	return out, nil
}

// JournalEntries lists entries with their postings, newest first.
func (s *Service) JournalEntries(ctx context.Context, p api.ListJournalEntriesParams) ([]api.JournalEntry, api.PageInfo, error) {
	if _, err := staff(ctx); err != nil {
		return nil, api.PageInfo{}, err
	}
	after, err := pagination.Decode(p.Cursor)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	after = firstPage(after, true)
	var from, to *time.Time
	if p.From != nil {
		from = &p.From.Time
	}
	if p.To != nil {
		to = &p.To.Time
	}
	lo, hi := dateRange(from, to)
	n := pagination.Limit(p.Limit)
	args := consoledb.ListJournalEntriesParams{FromTime: lo, ToTime: hi, AfterTime: after.Time, AfterID: after.ID, PageSize: int32(n + 1)} //nolint:gosec // n is at most 100
	if p.Kind != nil {
		args.Kind = string(*p.Kind)
	}
	if p.Reference != nil {
		args.Reference = *p.Reference
	}
	rows, err := s.q.ListJournalEntries(ctx, args)
	if err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("list entries: %w", err)
	}
	rows, page := pagination.Page(rows, n, func(r consoledb.ListJournalEntriesRow) pagination.Cursor {
		return pagination.Cursor{Time: r.CreatedAt, ID: r.ID}
	})
	in := make([]entryRow, len(rows))
	for i, r := range rows {
		in[i] = entryRow(r)
	}
	out, err := s.entriesJSON(ctx, in)
	return out, page, err
}

// JournalEntry is one entry with its postings.
func (s *Service) JournalEntry(ctx context.Context, id uuid.UUID) (api.JournalEntry, error) {
	if _, err := staff(ctx); err != nil {
		return api.JournalEntry{}, err
	}
	r, err := s.q.GetJournalEntry(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.JournalEntry{}, problem.NotFound("Journal entry")
	}
	if err != nil {
		return api.JournalEntry{}, fmt.Errorf("load entry: %w", err)
	}
	out, err := s.entriesJSON(ctx, []entryRow{entryRow(r)})
	if err != nil {
		return api.JournalEntry{}, err
	}
	return out[0], nil
}

// TrialBalance proves, per currency, that debits and credits cancel. It reads every posting up
// to as_of in one pass; the ledger's own commit-time trigger makes a non-zero net impossible, so
// this is the independent check an auditor runs.
func (s *Service) TrialBalance(ctx context.Context, asOf *time.Time) (api.TrialBalance, error) {
	if _, err := staff(ctx); err != nil {
		return api.TrialBalance{}, err
	}
	at := s.now().UTC()
	if asOf != nil {
		at = asOf.UTC()
	}
	start := time.Now()
	rows, err := s.q.TrialBalance(ctx, at)
	if err != nil {
		return api.TrialBalance{}, fmt.Errorf("trial balance: %w", err)
	}
	out := api.TrialBalance{AsOf: at, Balanced: true, Currencies: make([]api.TrialBalanceLine, len(rows))}
	for i, r := range rows {
		line := api.TrialBalanceLine{
			Currency: api.CurrencyCode(r.Currency), TotalDebits: apiMoney(r.TotalDebits, r.Currency),
			TotalCredits: apiMoney(r.TotalCredits, r.Currency), Net: apiMoney(r.Net, r.Currency),
			Balanced: r.Net == 0, Accounts: int(r.Accounts),
		}
		if !line.Balanced {
			out.Balanced = false
		}
		out.Currencies[i] = line
	}
	out.GeneratedInMs = int(time.Since(start).Milliseconds())
	return out, nil
}

// adjustmentLeg is one posting of a proposed manual adjustment, as kept in the approval.
type adjustmentLeg struct {
	AccountID   uuid.UUID `json:"account_id"`
	AmountMinor string    `json:"amount_minor"`
	Currency    string    `json:"currency"`
}

type adjustmentAfter struct {
	Reference string          `json:"reference"`
	Postings  []adjustmentLeg `json:"postings"`
}

// RequestLedgerAdjustment proposes a manual entry. Nothing posts until a finance or admin
// colleague approves it; the entry then carries the approval's ID (ADM-10).
func (s *Service) RequestLedgerAdjustment(ctx context.Context, req api.LedgerAdjustmentRequest) (api.ApprovalRequest, error) {
	if _, err := staff(ctx); err != nil {
		return api.ApprovalRequest{}, err
	}
	if n := utf8.RuneCountInString(strings.TrimSpace(req.Reason)); n < 10 || n > 500 {
		return api.ApprovalRequest{}, problem.Validation(problem.Field("/reason", "length", "Explain the adjustment in 10 to 500 characters."))
	}
	legs := make([]adjustmentLeg, 0, len(req.Postings))
	ids := make([]uuid.UUID, 0, len(req.Postings))
	sums := map[string]int64{}
	for i, p := range req.Postings {
		m, err := money.ParseMinor(p.Amount.AmountMinor, string(p.Amount.Currency))
		field := fmt.Sprintf("/postings/%d/amount", i)
		if err != nil || m.IsZero() {
			return api.ApprovalRequest{}, problem.Validation(problem.Field(field, "invalid", "Give a non-zero amount; credits are positive, debits negative."))
		}
		sums[string(m.Currency())] += m.Amount()
		legs = append(legs, adjustmentLeg{AccountID: p.AccountId, AmountMinor: p.Amount.AmountMinor, Currency: string(p.Amount.Currency)})
		ids = append(ids, p.AccountId)
	}
	for c, sum := range sums {
		if sum != 0 {
			return api.ApprovalRequest{}, problem.Validation(problem.Field("/postings", "unbalanced", "The postings must add up to zero in "+c+"."))
		}
	}
	accs, err := s.q.ListAccountCurrencies(ctx, ids)
	if err != nil {
		return api.ApprovalRequest{}, fmt.Errorf("check accounts: %w", err)
	}
	known := map[uuid.UUID]string{}
	for _, a := range accs {
		known[a.ID] = a.Currency
	}
	for i, l := range legs {
		cur, ok := known[l.AccountID]
		if !ok {
			return api.ApprovalRequest{}, problem.Validation(problem.Field(fmt.Sprintf("/postings/%d/account_id", i), "unknown", "No such ledger account."))
		}
		if cur != l.Currency {
			return api.ApprovalRequest{}, problem.Validation(problem.Field(fmt.Sprintf("/postings/%d/amount", i), "currency", "That account holds "+cur+"."))
		}
	}
	ref := ""
	if req.Reference != nil {
		ref = strings.TrimSpace(*req.Reference)
	}
	return s.propose(ctx, admin.Proposal{
		Action: admin.ActionLedgerAdjustment, Reason: req.Reason, Summary: fmt.Sprintf("Manual ledger adjustment, %d postings", len(legs)),
		After: map[string]any{"reference": ref, "postings": legs},
	})
}

// applyAdjustment posts an approved adjustment in the approval's transaction.
func (s *Service) applyAdjustment(ctx context.Context, tx pgx.Tx, a admin.Approval) (admin.Effect, error) {
	in, err := decodeAfter[adjustmentAfter](a)
	if err != nil {
		return admin.Effect{}, err
	}
	legs := make([]ledger.Leg, len(in.Postings))
	for i, p := range in.Postings {
		m, err := money.ParseMinor(p.AmountMinor, p.Currency)
		if err != nil {
			return admin.Effect{}, fmt.Errorf("adjustment leg %d: %w", i, err)
		}
		legs[i] = ledger.Leg{Account: p.AccountID, Amount: m}
	}
	ref := in.Reference
	if ref == "" {
		ref = "ADJ-" + strings.ToUpper(a.ID.String()[24:])
	}
	posted, err := ledger.Post(ctx, tx, ledger.Entry{
		Kind: "manual_adjustment", Reference: ref, IdempotencyKey: "adjustment:" + a.ID.String(), ApprovalID: &a.ID,
		Metadata: map[string]any{"approval_id": a.ID.String(), "maker_id": a.Maker.ID.String()}, Legs: legs,
	})
	if err != nil {
		return admin.Effect{}, fmt.Errorf("post adjustment: %w", err)
	}
	return admin.Effect{AuditAction: "ledger.adjustment.post", ResourceType: "journal_entry", ResourceID: posted.EntryID.String()}, nil
}
