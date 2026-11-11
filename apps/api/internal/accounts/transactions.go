package accounts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts/accountsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/categorize"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/pagination"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// ErrTransactionNotFound is the 404 for a transaction the caller cannot see.
var ErrTransactionNotFound = problem.NotFound("Transaction")

// disputeWindow is how long after a payment a customer can dispute it (DSP-1, mock bank).
const disputeWindow = 60 * 24 * time.Hour

// lagos is West Africa Time (no daylight saving): history date filters are Lagos days.
var lagos = time.FixedZone("WAT", 60*60)

// Line is one transaction line for Record: one account's side of a business movement.
type Line struct {
	// ID is the line's ID when the caller needs it in advance (a transfer points at its
	// line); zero means a new one.
	ID        uuid.UUID
	UserID    uuid.UUID
	AccountID uuid.UUID
	// Type is a contract TransactionType ("transfer_out", "deposit", ...).
	Type string
	// Direction is "credit" or "debit".
	Direction string
	// Status is "pending" for money not yet moved, else "completed" (or "failed").
	Status string
	// Amount is positive, in the account's currency.
	Amount money.Money
	// Fee is charged on top of Amount (debits) or levied on it (credits); FeeCode names it.
	Fee     *money.Money
	FeeCode string
	// Entry is the posted journal entry; nil while the money has not moved.
	Entry *ledger.Posted
	// Narration is the customer-facing description, Reference the payment reference.
	Narration, Reference string
	// Category is a contract Category. CategorySource says who chose it ("rules" by default,
	// or "model" with CategoryConfidence); a customer's own rule for the merchant replaces either.
	Category           string
	CategorySource     string
	CategoryConfidence *float64
	Counterparty       api.Counterparty
	TransferID         *uuid.UUID
	CardID             *uuid.UUID
	// At defaults to the entry's time, else now.
	At time.Time
}

// Record writes a transaction line in the caller's transaction, beside the ledger entry
// it describes. The balance after comes from the entry's own postings, so it is the exact
// running balance of the ledger, not a recomputation.
func Record(ctx context.Context, tx pgx.Tx, l Line) (accountsdb.Transaction, error) {
	if !l.Amount.IsPositive() {
		return accountsdb.Transaction{}, errors.New("accounts: a transaction amount is positive; direction gives the sign")
	}
	id := l.ID
	if id == uuid.Nil {
		var err error
		if id, err = uuid.NewV7(); err != nil {
			return accountsdb.Transaction{}, fmt.Errorf("transaction id: %w", err)
		}
	}
	cp, err := json.Marshal(l.Counterparty)
	if err != nil {
		return accountsdb.Transaction{}, fmt.Errorf("counterparty: %w", err)
	}
	source, confidence := l.CategorySource, l.CategoryConfidence
	if source == "" {
		source = "rules"
	}
	if source != "model" {
		confidence = nil
	}
	q := accountsdb.New(tx)
	// The customer's word beats every guess: an "always file this merchant as..." rule.
	rule, err := q.GetMerchantRule(ctx, accountsdb.GetMerchantRuleParams{
		UserID: l.UserID, MerchantKey: categorize.MerchantKey(l.Counterparty.Name),
	})
	switch {
	case err == nil:
		l.Category, source, confidence = rule, "user", nil
	case !errors.Is(err, pgx.ErrNoRows):
		return accountsdb.Transaction{}, fmt.Errorf("merchant rule: %w", err)
	}
	p := accountsdb.InsertTransactionParams{
		ID: id, UserID: l.UserID, AccountID: l.AccountID, Currency: string(l.Amount.Currency()),
		Type: l.Type, Direction: l.Direction, Status: l.Status, AmountMinor: l.Amount.Amount(),
		Narration: l.Narration, Reference: l.Reference, Category: l.Category, CategorySource: source,
		Counterparty: cp, TransferID: l.TransferID, CardID: l.CardID, CreatedAt: l.At,
	}
	if confidence != nil {
		c := float32(*confidence)
		p.CategoryConfidence = &c
	}
	if l.Fee != nil && l.Fee.IsPositive() {
		f, code := l.Fee.Amount(), l.FeeCode
		p.FeeMinor, p.FeeCode = &f, &code
	}
	if l.Entry != nil {
		p.EntryID = &l.Entry.EntryID
		p.BalanceAfterMinor = BalanceAfter(*l.Entry, l.AccountID)
		if p.CreatedAt.IsZero() {
			p.CreatedAt = l.Entry.CreatedAt
		}
	}
	if p.CreatedAt.IsZero() {
		p.CreatedAt = time.Now()
	}
	t, err := q.InsertTransaction(ctx, p)
	if err != nil {
		return accountsdb.Transaction{}, fmt.Errorf("insert transaction: %w", err)
	}
	return t, nil
}

// Settle moves a pending line to its outcome: "completed" with the entry that moved the
// money, or "failed"/"reversed".
func Settle(ctx context.Context, tx pgx.Tx, id uuid.UUID, status string, entry *ledger.Posted, account uuid.UUID) (accountsdb.Transaction, error) {
	return SettleAmount(ctx, tx, id, status, entry, account, nil)
}

// SettleAmount is Settle for a line whose final amount differs from the pending one: a card
// merchant that captures less than it authorized.
func SettleAmount(ctx context.Context, tx pgx.Tx, id uuid.UUID, status string, entry *ledger.Posted, account uuid.UUID, amount *money.Money) (accountsdb.Transaction, error) {
	p := accountsdb.SettleTransactionParams{Status: status, ID: id}
	if amount != nil {
		minor := amount.Amount()
		p.AmountMinor = &minor
	}
	if entry != nil {
		p.EntryID = &entry.EntryID
		p.BalanceAfterMinor = BalanceAfter(*entry, account)
	}
	t, err := accountsdb.New(tx).SettleTransaction(ctx, p)
	if err != nil {
		return accountsdb.Transaction{}, fmt.Errorf("settle transaction: %w", err)
	}
	return t, nil
}

// BalanceAfter is the account's ledger balance after its last posting in the entry.
func BalanceAfter(e ledger.Posted, account uuid.UUID) *int64 {
	var after *int64
	for i := range e.Postings {
		if e.Postings[i].AccountID == account {
			after = &e.Postings[i].BalanceAfterMinor
		}
	}
	return after
}

// Filter is the history query (ACC-5). Zero fields do not filter.
type Filter struct {
	AccountID *uuid.UUID
	Types     []string
	Currency  *string
	Status    *string
	Category  *string
	// From and To are inclusive Lagos dates.
	From, To *time.Time
	Query    string
	Cursor   *string
	Limit    *int
}

// Transactions pages through the caller's history, newest first.
func (s *Service) Transactions(ctx context.Context, f Filter) ([]accountsdb.Transaction, api.PageInfo, error) {
	p, _, err := s.caller(ctx)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	return s.TransactionsFor(ctx, p.UserID, f)
}

// TransactionsFor pages through one customer's history, newest first. The caller has decided
// the viewer may see it (a guardian reading a dependant's activity, FAM-3); this method does not.
func (s *Service) TransactionsFor(ctx context.Context, userID uuid.UUID, f Filter) ([]accountsdb.Transaction, api.PageInfo, error) {
	prof, err := s.customers.CustomerProfile(ctx, userID)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	after, err := pagination.Decode(f.Cursor)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	limit := pagination.Limit(f.Limit)
	params := accountsdb.ListTransactionsParams{
		UserID: userID, AccountID: f.AccountID, Types: f.Types, Currency: f.Currency, Status: f.Status,
		Category: f.Category, AfterID: after.ID, AfterAt: after.Time, Lim: int32(limit + 1), //nolint:gosec // limit ≤ pagination.MaxLimit
	}
	if len(params.Types) == 0 {
		params.Types = nil
	}
	if f.From != nil {
		since := lagosMidnight(*f.From)
		params.Since = &since
	}
	if f.To != nil {
		until := lagosMidnight(*f.To).AddDate(0, 0, 1)
		params.Until = &until
	}
	if q := strings.TrimSpace(f.Query); q != "" {
		pattern := "%" + likeEscaper.Replace(q) + "%"
		params.Pattern = &pattern
	}
	if prof.InDuress {
		// The decoy view shows only small naira activity, to match the decoy balance.
		if f.Currency != nil && *f.Currency != string(money.NGN) {
			return []accountsdb.Transaction{}, api.PageInfo{}, nil
		}
		ngn, maxAmount := string(money.NGN), decoyMaxTransaction.Amount()
		params.Currency, params.MaxAmountMinor = &ngn, &maxAmount
	}
	rows, err := s.q.ListTransactions(ctx, params)
	if err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("list transactions: %w", err)
	}
	items, page := pagination.Page(rows, limit, func(t accountsdb.Transaction) pagination.Cursor {
		return pagination.Cursor{Time: t.CreatedAt, ID: t.ID}
	})
	if prof.InDuress {
		for i := range items {
			items[i].BalanceAfterMinor = nil // the real running balance would give the decoy away
		}
	}
	return items, page, nil
}

// Detail is a transaction with what the customer can do next (ACC-6).
type Detail struct {
	accountsdb.Transaction
	CanDispute bool
	CanRepeat  bool
	// Timeline is the transfer's status history, or one step for the line's status.
	Timeline []api.TimelineEvent
}

// Transaction returns one of the caller's transactions.
func (s *Service) Transaction(ctx context.Context, id uuid.UUID) (Detail, error) {
	p, prof, err := s.caller(ctx)
	if err != nil {
		return Detail{}, err
	}
	t, err := s.q.GetTransaction(ctx, accountsdb.GetTransactionParams{ID: id, UserID: p.UserID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Detail{}, ErrTransactionNotFound
	}
	if err != nil {
		return Detail{}, fmt.Errorf("load transaction: %w", err)
	}
	if prof.InDuress {
		// Outside the decoy view's activity it does not exist, as in the list.
		if t.Currency != string(money.NGN) || t.AmountMinor > decoyMaxTransaction.Amount() {
			return Detail{}, ErrTransactionNotFound
		}
		t.BalanceAfterMinor = nil
	}
	d := Detail{
		Transaction: t,
		CanDispute:  t.Direction == "debit" && t.Status == "completed" && s.now().Sub(t.CreatedAt) <= disputeWindow,
		CanRepeat:   t.Type == "transfer_out" && t.TransferID != nil,
	}
	if t.TransferID != nil && s.timelines != nil {
		if d.Timeline, err = s.timelines(ctx, *t.TransferID); err != nil {
			return Detail{}, err
		}
	}
	if len(d.Timeline) == 0 {
		d.Timeline = []api.TimelineEvent{{Status: t.Status, Label: statusLabel(t.Status), At: t.UpdatedAt.UTC()}}
	}
	return d, nil
}

// likeEscaper makes a search term match literally inside ILIKE (backslash is the escape).
var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

func lagosMidnight(d time.Time) time.Time {
	return time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, lagos)
}

// Recategorize is the customer's correction of a transaction's category (AI-3). It beats any
// rule or model guess, is kept as a labelled example for retraining and, when asked, becomes
// the customer's rule for that merchant: every other line from it changes now, and future
// ones are filed the same way as they are recorded.
func (s *Service) Recategorize(ctx context.Context, id uuid.UUID, category string, applyToSimilar bool) (Detail, error) {
	if !categorize.ValidCategory(category) {
		return Detail{}, problem.New(http.StatusBadRequest, problem.CodeValidationFailed, "That is not a category")
	}
	// Reading it first applies ownership and the duress decoy exactly as the detail view does.
	before, err := s.Transaction(ctx, id)
	if err != nil {
		return Detail{}, err
	}
	key := categorize.MerchantKey(counterpartyName(before.Transaction))
	correctionID, err := uuid.NewV7()
	if err != nil {
		return Detail{}, fmt.Errorf("correction id: %w", err)
	}
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		if _, err := q.SetTransactionCategory(ctx, accountsdb.SetTransactionCategoryParams{
			ID: id, UserID: before.UserID, Category: category,
		}); err != nil {
			return fmt.Errorf("set category: %w", err)
		}
		if err := q.InsertCategoryCorrection(ctx, accountsdb.InsertCategoryCorrectionParams{
			ID: correctionID, UserID: before.UserID, TransactionID: id, MerchantKey: key,
			Text:             strings.TrimSpace(counterpartyName(before.Transaction) + " " + before.Narration),
			PreviousCategory: before.Category, PreviousSource: before.CategorySource,
			PreviousConfidence: before.CategoryConfidence, Category: category, ApplyToSimilar: applyToSimilar,
		}); err != nil {
			return fmt.Errorf("record correction: %w", err)
		}
		if applyToSimilar && key != "" {
			if err := q.UpsertMerchantRule(ctx, accountsdb.UpsertMerchantRuleParams{
				UserID: before.UserID, MerchantKey: key, Category: category,
			}); err != nil {
				return fmt.Errorf("save merchant rule: %w", err)
			}
			if _, err := q.RecategorizeMerchant(ctx, accountsdb.RecategorizeMerchantParams{
				UserID: before.UserID, MerchantKey: key, Category: category, ExceptID: id,
			}); err != nil {
				return fmt.Errorf("recategorize merchant: %w", err)
			}
		}
		return nil
	})
	if err != nil {
		return Detail{}, err
	}
	return s.Transaction(ctx, id)
}

// counterpartyName is the name on a line's counterparty, which is what merchants are keyed by.
func counterpartyName(t accountsdb.Transaction) string {
	var cp struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(t.Counterparty, &cp); err != nil {
		return ""
	}
	return cp.Name
}

// ExportCorrections writes every customer correction as JSON lines (text and the category the
// customer chose): the labelled examples smart categories retrains on.
func (s *Service) ExportCorrections(ctx context.Context, w io.Writer) (int, error) {
	rows, err := s.q.ListCategoryCorrections(ctx)
	if err != nil {
		return 0, fmt.Errorf("list corrections: %w", err)
	}
	enc := json.NewEncoder(w)
	for _, r := range rows {
		if err := enc.Encode(map[string]any{
			"text": r.Text, "label": r.Category, "previous": r.PreviousCategory, "previous_source": r.PreviousSource,
			"at": r.CreatedAt,
		}); err != nil {
			return 0, fmt.Errorf("write correction: %w", err)
		}
	}
	return len(rows), nil
}
