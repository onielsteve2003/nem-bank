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
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/admin"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/console/consoledb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/pagination"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

var errNoCustomer = problem.NotFound("Customer")

func summaryOf(id uuid.UUID, first, last, email, phone string, nemtag *string, tier int16, frozenAt *time.Time, createdAt time.Time) api.CustomerSummary {
	status := api.CustomerSummaryStatus("active")
	if frozenAt != nil {
		status = "frozen"
	}
	return api.CustomerSummary{
		UserId: id, Name: first + " " + last, EmailMasked: maskEmail(email), PhoneMasked: maskPhone(phone), Nemtag: nemtag,
		KycTier: api.KycTier(tier), Status: status, CreatedAt: createdAt.UTC(),
	}
}

// customerSummary loads one customer's summary, or 404.
func (s *Service) customerSummary(ctx context.Context, id uuid.UUID) (api.CustomerSummary, error) {
	u, err := s.q.GetCustomer(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.CustomerSummary{}, errNoCustomer
	}
	if err != nil {
		return api.CustomerSummary{}, fmt.Errorf("load customer: %w", err)
	}
	return summaryOf(u.ID, u.FirstName, u.LastName, u.Email, u.Phone, u.Nemtag, u.KycTier, u.FrozenAt, u.CreatedAt), nil
}

// SearchCustomers finds customers by name, email, phone, @tag or account number. Every search is
// audit-logged (by the length of the term, not the term: it may be someone's phone number).
func (s *Service) SearchCustomers(ctx context.Context, q string, cursor *string, limit *int) ([]api.CustomerSummary, api.PageInfo, error) {
	p, err := staff(ctx)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	term := strings.ToLower(strings.TrimSpace(q))
	if utf8.RuneCountInString(term) < 2 {
		return nil, api.PageInfo{}, problem.Validation(problem.Field("/q", "too_short", "Type at least 2 characters."))
	}
	after, err := pagination.Decode(cursor)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	if after.IsZero() {
		after = pagination.Cursor{Time: s.now().Add(24 * time.Hour), ID: uuid.Max}
	}
	n := pagination.Limit(limit)
	rows, err := s.q.SearchCustomers(ctx, consoledb.SearchCustomersParams{
		AfterTime: after.Time, AfterID: after.ID, Term: likeEscaper.Replace(term), PageSize: int32(n + 1), //nolint:gosec // n is at most 100
	})
	if err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("search customers: %w", err)
	}
	if err := s.inTx(ctx, func(tx pgx.Tx, _ *consoledb.Queries) error {
		return s.record(ctx, tx, actorOf(p), "customer.search", "customer_search", uuid.NewString(), map[string]any{"term_length": utf8.RuneCountInString(term)})
	}); err != nil {
		return nil, api.PageInfo{}, err
	}
	rows, page := pagination.Page(rows, n, func(r consoledb.SearchCustomersRow) pagination.Cursor {
		return pagination.Cursor{Time: r.CreatedAt, ID: r.ID}
	})
	out := make([]api.CustomerSummary, len(rows))
	for i, r := range rows {
		out[i] = summaryOf(r.ID, r.FirstName, r.LastName, r.Email, r.Phone, r.Nemtag, r.KycTier, r.FrozenAt, r.CreatedAt)
	}
	return out, page, nil
}

// Customer360 is everything a staff member needs about one customer. Opening it is audited. The
// date of birth is hidden from the support role.
func (s *Service) Customer360(ctx context.Context, id uuid.UUID) (api.Customer360, error) {
	p, err := staff(ctx)
	if err != nil {
		return api.Customer360{}, err
	}
	out, err := s.customer360(ctx, p, id)
	if err != nil {
		return api.Customer360{}, err
	}
	return out, s.inTx(ctx, func(tx pgx.Tx, _ *consoledb.Queries) error {
		return s.record(ctx, tx, actorOf(p), "customer.view", "customer", id.String(), nil)
	})
}

func (s *Service) customer360(ctx context.Context, p admin.Principal, id uuid.UUID) (api.Customer360, error) {
	u, err := s.q.GetCustomer(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.Customer360{}, errNoCustomer
	}
	if err != nil {
		return api.Customer360{}, fmt.Errorf("load customer: %w", err)
	}
	now := s.now()
	out := api.Customer360{
		Customer: summaryOf(u.ID, u.FirstName, u.LastName, u.Email, u.Phone, u.Nemtag, u.KycTier, u.FrozenAt, u.CreatedAt),
		Accounts: []api.Account{}, Notes: []api.StaffNote{}, RecentTransactions: []api.Transaction{}, Flags: []api.Customer360Flags{},
	}
	// Support sees the customer without their date of birth; the other roles do.
	if p.HasAny(admin.RoleCompliance, admin.RoleFinance, admin.RoleAdmin) {
		if u.DateOfBirth.Valid {
			out.DateOfBirth = &openapi_types.Date{Time: u.DateOfBirth.Time}
		}
	}

	views, err := s.accounts.ViewsFor(ctx, id)
	if err != nil {
		return api.Customer360{}, err
	}
	for _, v := range views {
		a, err := accounts.AccountJSON(v)
		if err != nil {
			return api.Customer360{}, err
		}
		out.Accounts = append(out.Accounts, a)
	}
	if out.Devices, err = s.identity.DevicesFor(ctx, id); err != nil {
		return api.Customer360{}, err
	}
	if out.Devices == nil {
		out.Devices = []api.Device{}
	}
	coolOff := false
	for _, d := range out.Devices {
		if d.CoolOffUntil != nil && d.CoolOffUntil.After(now) {
			coolOff = true
		}
	}

	out.Kyc.Tier, out.Kyc.Status = api.KycTier(u.KycTier), api.KycStatus(u.KycStatus)
	if out.Kyc.LatestSubmission, err = s.kyc.LatestSubmission(ctx, id); err != nil {
		return api.Customer360{}, err
	}

	txs, _, err := s.accounts.TransactionsFor(ctx, id, accounts.Filter{Limit: ptr(20)})
	if err != nil {
		return api.Customer360{}, err
	}
	for _, t := range txs {
		j, err := accounts.TransactionJSON(t)
		if err != nil {
			return api.Customer360{}, err
		}
		out.RecentTransactions = append(out.RecentTransactions, j)
	}

	notes, err := s.q.ListNotes(ctx, id)
	if err != nil {
		return api.Customer360{}, fmt.Errorf("list notes: %w", err)
	}
	for _, n := range notes {
		out.Notes = append(out.Notes, api.StaffNote{Id: n.ID, Author: api.StaffRef{Id: n.AuthorID, Name: n.AuthorName}, Body: n.Body, CreatedAt: n.CreatedAt.UTC()})
	}

	cases, err := s.q.CustomerOpenCases(ctx, id)
	if err != nil {
		return api.Customer360{}, fmt.Errorf("count cases: %w", err)
	}
	out.OpenCases.Fraud, out.OpenCases.Disputes, out.OpenCases.Support = int(cases.Fraud), int(cases.Disputes), int(cases.Support)

	override, err := s.q.CustomerHasLimitOverride(ctx, consoledb.CustomerHasLimitOverrideParams{UserID: id, Now: now})
	if err != nil {
		return api.Customer360{}, fmt.Errorf("check limit override: %w", err)
	}
	flag := func(on bool, f api.Customer360Flags) {
		if on {
			out.Flags = append(out.Flags, f)
		}
	}
	flag(u.FrozenAt != nil, api.Customer360FlagsFrozen)
	flag(u.DuressSince != nil, api.Customer360FlagsDuressTriggered)
	flag(cases.Fraud > 0, api.Customer360FlagsFraudWatch)
	flag(coolOff, api.Customer360FlagsNewDeviceCoolOff)
	flag(override, api.Customer360FlagsLimitOverride)
	flag(u.IsDemo, api.Customer360FlagsDemo)

	// The customer's own panic button has no server side yet; what a staff freeze does shows
	// here, so a reviewer can see whether outgoing money is blocked.
	out.Panic = api.PanicState{OutgoingBlocked: u.FrozenAt != nil}
	return out, nil
}

// AddNote attaches a note to a customer.
func (s *Service) AddNote(ctx context.Context, id uuid.UUID, body string) (api.StaffNote, error) {
	p, err := staff(ctx)
	if err != nil {
		return api.StaffNote{}, err
	}
	body = strings.TrimSpace(body)
	if n := utf8.RuneCountInString(body); n < 1 || n > 2000 {
		return api.StaffNote{}, problem.Validation(problem.Field("/body", "length", "Write a note of 1 to 2,000 characters."))
	}
	if _, err := s.customerSummary(ctx, id); err != nil {
		return api.StaffNote{}, err
	}
	noteID, err := uuid.NewV7()
	if err != nil {
		return api.StaffNote{}, fmt.Errorf("note id: %w", err)
	}
	now := s.now().UTC()
	err = s.inTx(ctx, func(tx pgx.Tx, q *consoledb.Queries) error {
		if err := q.InsertNote(ctx, consoledb.InsertNoteParams{ID: noteID, UserID: id, AuthorID: p.StaffID, Body: body, CreatedAt: now}); err != nil {
			return fmt.Errorf("insert note: %w", err)
		}
		// The note's text is never copied into the log (it is free text and may hold PII).
		return s.record(ctx, tx, actorOf(p), "customer.note", "customer", id.String(), map[string]any{"note_id": noteID.String()})
	})
	if err != nil {
		return api.StaffNote{}, err
	}
	return api.StaffNote{Id: noteID, Author: api.StaffRef{Id: p.StaffID, Name: p.Name}, Body: body, CreatedAt: now}, nil
}

var (
	errAlreadyFrozen = problem.Conflict("This customer is already frozen.")
	errNotFrozen     = problem.Conflict("This customer is not frozen.")
)

// Freeze blocks a customer's logins and outgoing money at once, ends their sessions and returns
// the refreshed customer view. Unfreezing is a different, two-person action.
func (s *Service) Freeze(ctx context.Context, id uuid.UUID, reason string) (api.Customer360, error) {
	p, err := staff(ctx)
	if err != nil {
		return api.Customer360{}, err
	}
	reason = strings.TrimSpace(reason)
	if n := utf8.RuneCountInString(reason); n < 5 || n > 500 {
		return api.Customer360{}, admin.ErrBadReason
	}
	now := s.now().UTC()
	err = s.inTx(ctx, func(tx pgx.Tx, q *consoledb.Queries) error {
		u, err := q.LockCustomer(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return errNoCustomer
		}
		if err != nil {
			return fmt.Errorf("lock customer: %w", err)
		}
		if u.FrozenAt != nil {
			return errAlreadyFrozen
		}
		if err := q.FreezeCustomer(ctx, consoledb.FreezeCustomerParams{ID: id, At: &now, Reason: &reason}); err != nil {
			return fmt.Errorf("freeze customer: %w", err)
		}
		if err := q.SetCustomerAccountsStatus(ctx, consoledb.SetCustomerAccountsStatusParams{UserID: id, FromStatus: "active", ToStatus: "frozen"}); err != nil {
			return fmt.Errorf("freeze accounts: %w", err)
		}
		if err := q.RevokeAllSessions(ctx, id); err != nil {
			return fmt.Errorf("revoke sessions: %w", err)
		}
		return s.record(ctx, tx, actorOf(p), "customer.freeze", "customer", id.String(), nil)
	})
	if err != nil {
		return api.Customer360{}, err
	}
	return s.customer360(ctx, p, id)
}

// RequestUnfreeze proposes lifting a freeze; another staff member has to approve it (ADM-10).
func (s *Service) RequestUnfreeze(ctx context.Context, id uuid.UUID, reason string) (api.ApprovalRequest, error) {
	sum, err := s.customerSummary(ctx, id)
	if err != nil {
		return api.ApprovalRequest{}, err
	}
	if sum.Status != "frozen" {
		return api.ApprovalRequest{}, errNotFrozen
	}
	return s.propose(ctx, admin.Proposal{
		Action: admin.ActionCustomerUnfreeze, Reason: reason, Summary: "Unfreeze " + sum.Name,
		Before: map[string]any{"user_id": id.String(), "status": "frozen"},
		After:  map[string]any{"user_id": id.String(), "status": "active"},
	})
}

// RequestLimitOverride proposes a temporary higher daily limit for one customer.
func (s *Service) RequestLimitOverride(ctx context.Context, id uuid.UUID, req api.LimitOverrideRequest) (api.ApprovalRequest, error) {
	sum, err := s.customerSummary(ctx, id)
	if err != nil {
		return api.ApprovalRequest{}, err
	}
	amt, err := money.ParseMinor(req.DailyLimit.AmountMinor, string(req.DailyLimit.Currency))
	if err != nil || amt.Currency() != money.NGN || !amt.IsPositive() {
		return api.ApprovalRequest{}, problem.Validation(problem.Field("/daily_limit", "invalid", "Give a naira amount above zero."))
	}
	if amt.Amount() > maxOverrideMinor {
		return api.ApprovalRequest{}, problem.Validation(problem.Field("/daily_limit", "too_large", "An override cannot go above ₦50,000,000 a day."))
	}
	exp := req.ExpiresAt.UTC()
	if !exp.After(s.now()) || exp.After(s.now().Add(maxOverrideLife)) {
		return api.ApprovalRequest{}, problem.Validation(problem.Field("/expires_at", "range", "Pick a time in the next 30 days."))
	}
	cur := s.limits.Rules().Tier(int(sum.KycTier))
	return s.propose(ctx, admin.Proposal{
		Action: admin.ActionLimitOverride, Reason: req.Reason, Summary: "Raise daily limit for " + sum.Name,
		Before: map[string]any{"user_id": id.String(), "daily_minor": fmt.Sprint(cur.DailyMinor)},
		After:  map[string]any{"user_id": id.String(), "daily_minor": fmt.Sprint(amt.Amount()), "expires_at": exp.Format(time.RFC3339)},
	})
}

const (
	maxOverrideMinor = 50_000_000 * 100
	maxOverrideLife  = 30 * 24 * time.Hour
)

// propose records a maker-checker request and returns it as the contract's ApprovalRequest.
func (s *Service) propose(ctx context.Context, pr admin.Proposal) (api.ApprovalRequest, error) {
	var id uuid.UUID
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var err error
		id, err = s.admin.Propose(ctx, tx, pr)
		return err
	})
	if err != nil {
		return api.ApprovalRequest{}, err
	}
	return s.admin.APIApproval(ctx, id)
}
