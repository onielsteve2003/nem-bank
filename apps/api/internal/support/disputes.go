package support

import (
	"context"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/audit"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/pagination"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/support/supportdb"
)

// TopicDisputeUpdated is the outbox event for any change to a dispute; the realtime and
// notification subscribers listen to it.
const TopicDisputeUpdated = "dispute.updated"

// open statuses are the ones a customer can still add to and staff can still decide.
var openStatuses = []string{"submitted", "under_review", "awaiting_customer"}

// Problems.
var (
	// ErrDisputeNotFound is the 404 for a dispute the caller does not have.
	ErrDisputeNotFound = problem.NotFound("Dispute")
	// ErrDisputeClosed is the 409 for changing a dispute that is already settled or withdrawn.
	ErrDisputeClosed = problem.New(http.StatusConflict, "invalid_state", "This dispute is already closed")

	errAlreadyOpen   = problem.New(http.StatusConflict, "dispute_already_open", "You already have an open dispute for this transaction")
	errNotDisputable = problem.New(http.StatusUnprocessableEntity, "not_disputable", "This transaction cannot be disputed").
				WithDetail("Wait until a pending payment completes, and note that refunds cannot be disputed.")
	errOutsideWindow = problem.New(http.StatusUnprocessableEntity, "dispute_window_closed", "This transaction is too old to dispute").
				WithDetail("Disputes can be raised within 120 days of the transaction.")
	errMaxEvidence = problem.New(http.StatusConflict, "too_much_evidence", "A dispute can hold at most five files")
)

// CreateDisputeRequest is DSP-1's form.
type CreateDisputeRequest struct {
	TransactionID uuid.UUID
	Reason        string
	Description   string
	AttachmentIDs []uuid.UUID
}

// CreateDispute raises a dispute on one of the customer's own transactions. A transaction has at
// most one open dispute; the case number is returned to quote to support.
func (s *Service) CreateDispute(ctx context.Context, req CreateDisputeRequest) (api.Dispute, error) {
	p, err := principal(ctx)
	if err != nil {
		return api.Dispute{}, err
	}
	desc := strings.TrimSpace(req.Description)
	if n := utf8.RuneCountInString(desc); n < 10 || n > 1000 {
		return api.Dispute{}, problem.Validation(problem.Field("/description", "length", "Describe what happened in 10 to 1,000 characters."))
	}
	id, err := uuid.NewV7()
	if err != nil {
		return api.Dispute{}, fmt.Errorf("dispute id: %w", err)
	}
	now := s.now().UTC()
	var out supportdb.Dispute
	err = s.inTx(ctx, func(tx pgx.Tx, q *supportdb.Queries) error {
		t, err := q.GetTransactionAny(ctx, req.TransactionID)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && t.UserID != p.UserID) {
			return problem.NotFound("Transaction")
		}
		if err != nil {
			return fmt.Errorf("load transaction: %w", err)
		}
		if t.Status == "pending" || t.Type == "dispute_refund" {
			return errNotDisputable
		}
		if now.Sub(t.CreatedAt) > disputeWindow {
			return errOutsideWindow
		}
		if err := s.claim(ctx, q, p.UserID, req.AttachmentIDs, "dispute", "support"); err != nil {
			return err
		}
		caseNo, err := q.NextCaseNumber(ctx)
		if err != nil {
			return fmt.Errorf("case number: %w", err)
		}
		evidence := req.AttachmentIDs
		if evidence == nil {
			evidence = []uuid.UUID{}
		}
		out, err = q.InsertDispute(ctx, supportdb.InsertDisputeParams{
			ID: id, UserID: p.UserID, TransactionID: t.ID, CaseNumber: caseNo, Reason: req.Reason, Description: desc, EvidenceIds: evidence, CreatedAt: now,
		})
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.ConstraintName == "disputes_one_open" {
			return errAlreadyOpen
		}
		if err != nil {
			return fmt.Errorf("insert dispute: %w", err)
		}
		if err := s.event(ctx, q, out.ID, "submitted", "Dispute submitted", "Case "+out.CaseNumber, now); err != nil {
			return err
		}
		return emitDispute(ctx, tx, out)
	})
	if err != nil {
		return api.Dispute{}, err
	}
	return s.disputeJSON(ctx, s.q, out)
}

func emitDispute(ctx context.Context, tx pgx.Tx, d supportdb.Dispute) error {
	return emit(ctx, tx, TopicDisputeUpdated, "dispute", d.ID, map[string]any{
		"user_id": d.UserID, "dispute_id": d.ID, "case_number": d.CaseNumber, "status": d.Status,
	})
}

func (s *Service) event(ctx context.Context, q *supportdb.Queries, disputeID uuid.UUID, status, label, detail string, at time.Time) error {
	id, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("event id: %w", err)
	}
	var d *string
	if detail != "" {
		d = &detail
	}
	if err := q.InsertDisputeEvent(ctx, supportdb.InsertDisputeEventParams{ID: id, DisputeID: disputeID, Status: status, Label: label, Detail: d, At: at}); err != nil {
		return fmt.Errorf("insert dispute event: %w", err)
	}
	return nil
}

// disputeJSON is the contract's Dispute: timeline, evidence with fresh links, and the refund.
func (s *Service) disputeJSON(ctx context.Context, q *supportdb.Queries, d supportdb.Dispute) (api.Dispute, error) {
	events, err := q.ListDisputeEvents(ctx, d.ID)
	if err != nil {
		return api.Dispute{}, fmt.Errorf("load timeline: %w", err)
	}
	evidence, err := s.attachments(ctx, q, d.EvidenceIds)
	if err != nil {
		return api.Dispute{}, err
	}
	out := api.Dispute{
		Id: d.ID, CaseNumber: d.CaseNumber, TransactionId: d.TransactionID, Reason: api.DisputeReason(d.Reason), Description: d.Description,
		Status: api.DisputeStatus(d.Status), Timeline: make([]api.TimelineEvent, len(events)), Evidence: evidence,
		ResolutionNote: d.ResolutionNote, CreatedAt: d.CreatedAt.UTC(),
	}
	for i, e := range events {
		out.Timeline[i] = api.TimelineEvent{Status: e.Status, Label: e.Label, At: e.At.UTC(), Detail: e.Detail}
	}
	if d.RefundMinor != nil && d.RefundCurrency != nil {
		out.Refund = &api.Money{AmountMinor: strconv.FormatInt(*d.RefundMinor, 10), Currency: api.CurrencyCode(*d.RefundCurrency)}
	}
	if d.ResolvedAt != nil {
		t := d.ResolvedAt.UTC()
		out.ResolvedAt = &t
	}
	return out, nil
}

// Disputes lists the customer's disputes, newest first.
func (s *Service) Disputes(ctx context.Context, cursor *string, limit *int) ([]api.Dispute, api.PageInfo, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	after, err := pagination.Decode(cursor)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	// The first page starts after every row: year 9999 and the largest UUID.
	afterTime, afterID := time.Date(9999, 12, 31, 0, 0, 0, 0, time.UTC), uuid.UUID{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}
	if !after.IsZero() {
		afterTime, afterID = after.Time, after.ID
	}
	n := pagination.Limit(limit)
	rows, err := s.q.ListDisputes(ctx, supportdb.ListDisputesParams{UserID: p.UserID, AfterTime: afterTime, AfterID: afterID, PageSize: int32(n + 1)}) //nolint:gosec // n is at most 100
	if err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("list disputes: %w", err)
	}
	rows, page := pagination.Page(rows, n, func(r supportdb.Dispute) pagination.Cursor { return pagination.Cursor{Time: r.CreatedAt, ID: r.ID} })
	out := make([]api.Dispute, len(rows))
	for i, r := range rows {
		if out[i], err = s.disputeJSON(ctx, s.q, r); err != nil {
			return nil, api.PageInfo{}, err
		}
	}
	return out, page, nil
}

// Dispute is one of the customer's disputes with its timeline (DSP-2).
func (s *Service) Dispute(ctx context.Context, id uuid.UUID) (api.Dispute, error) {
	p, err := principal(ctx)
	if err != nil {
		return api.Dispute{}, err
	}
	d, err := s.q.GetDispute(ctx, supportdb.GetDisputeParams{ID: id, UserID: p.UserID})
	if errors.Is(err, pgx.ErrNoRows) {
		return api.Dispute{}, ErrDisputeNotFound
	}
	if err != nil {
		return api.Dispute{}, fmt.Errorf("load dispute: %w", err)
	}
	return s.disputeJSON(ctx, s.q, d)
}

// AddEvidence attaches one more file to an open dispute. If staff were waiting for the customer,
// the dispute goes back under review.
func (s *Service) AddEvidence(ctx context.Context, id uuid.UUID, form *multipart.Reader) (api.Dispute, error) {
	p, err := principal(ctx)
	if err != nil {
		return api.Dispute{}, err
	}
	cur, err := s.q.GetDispute(ctx, supportdb.GetDisputeParams{ID: id, UserID: p.UserID})
	if errors.Is(err, pgx.ErrNoRows) {
		return api.Dispute{}, ErrDisputeNotFound
	}
	if err != nil {
		return api.Dispute{}, fmt.Errorf("load dispute: %w", err)
	}
	if !slices.Contains(openStatuses, cur.Status) {
		return api.Dispute{}, ErrDisputeClosed
	}
	if len(cur.EvidenceIds) >= maxAttachments {
		return api.Dispute{}, errMaxEvidence
	}
	file, err := s.store(ctx, p.UserID, form, "dispute")
	if err != nil {
		return api.Dispute{}, err
	}
	now := s.now().UTC()
	var out supportdb.Dispute
	err = s.inTx(ctx, func(tx pgx.Tx, q *supportdb.Queries) error {
		d, err := q.LockDispute(ctx, id)
		if err != nil {
			return fmt.Errorf("lock dispute: %w", err)
		}
		if !slices.Contains(openStatuses, d.Status) {
			return ErrDisputeClosed
		}
		if len(d.EvidenceIds) >= maxAttachments {
			return errMaxEvidence
		}
		if out, err = q.AddDisputeEvidence(ctx, supportdb.AddDisputeEvidenceParams{ID: id, AttachmentID: file.ID}); err != nil {
			return fmt.Errorf("add evidence: %w", err)
		}
		if d.Status == "awaiting_customer" {
			if out, err = q.SetDisputeStatus(ctx, supportdb.SetDisputeStatusParams{ID: id, Status: "under_review"}); err != nil {
				return fmt.Errorf("back under review: %w", err)
			}
			if err := s.event(ctx, q, id, "under_review", "Back under review", "You sent more evidence", now); err != nil {
				return err
			}
		} else if err := s.event(ctx, q, id, d.Status, "Evidence added", file.FileName, now); err != nil {
			return err
		}
		return emitDispute(ctx, tx, out)
	})
	if err != nil {
		return api.Dispute{}, err
	}
	return s.disputeJSON(ctx, s.q, out)
}

// Withdraw closes the customer's own open dispute.
func (s *Service) Withdraw(ctx context.Context, id uuid.UUID) (api.Dispute, error) {
	p, err := principal(ctx)
	if err != nil {
		return api.Dispute{}, err
	}
	now := s.now().UTC()
	var out supportdb.Dispute
	err = s.inTx(ctx, func(tx pgx.Tx, q *supportdb.Queries) error {
		d, err := q.LockDispute(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && d.UserID != p.UserID) {
			return ErrDisputeNotFound
		}
		if err != nil {
			return fmt.Errorf("lock dispute: %w", err)
		}
		if !slices.Contains(openStatuses, d.Status) {
			return ErrDisputeClosed
		}
		if out, err = q.SetDisputeStatus(ctx, supportdb.SetDisputeStatusParams{ID: id, Status: "withdrawn", ResolvedAt: &now}); err != nil {
			return fmt.Errorf("withdraw: %w", err)
		}
		if err := s.event(ctx, q, id, "withdrawn", "You withdrew this dispute", "", now); err != nil {
			return err
		}
		return emitDispute(ctx, tx, out)
	})
	if err != nil {
		return api.Dispute{}, err
	}
	return s.disputeJSON(ctx, s.q, out)
}

// ---------------------------------------------------------------- staff

// DisputeView is a dispute with the customer and transaction a reviewer needs.
type DisputeView struct {
	Dispute     supportdb.Dispute
	Customer    Customer
	Transaction supportdb.Transaction
}

// Customer is who a case belongs to.
type Customer struct {
	ID   uuid.UUID
	Name string
}

func (s *Service) customer(ctx context.Context, q *supportdb.Queries, id uuid.UUID) (Customer, error) {
	u, err := q.CustomerBrief(ctx, id)
	if err != nil {
		return Customer{}, fmt.Errorf("load customer: %w", err)
	}
	return Customer{ID: id, Name: u.FirstName + " " + u.LastName}, nil
}

// DisputeQueue lists disputes for staff, oldest first. An empty status means every open one.
func (s *Service) DisputeQueue(ctx context.Context, status string, cursor *string, limit *int) ([]DisputeView, api.PageInfo, error) {
	after, err := pagination.Decode(cursor)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	n := pagination.Limit(limit)
	rows, err := s.q.ListDisputeQueue(ctx, supportdb.ListDisputeQueueParams{Status: status, AfterTime: after.Time, AfterID: after.ID, PageSize: int32(n + 1)}) //nolint:gosec // n is at most 100
	if err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("list dispute queue: %w", err)
	}
	rows, page := pagination.Page(rows, n, func(r supportdb.Dispute) pagination.Cursor { return pagination.Cursor{Time: r.CreatedAt, ID: r.ID} })
	out := make([]DisputeView, len(rows))
	for i, r := range rows {
		if out[i], err = s.view(ctx, r); err != nil {
			return nil, api.PageInfo{}, err
		}
	}
	return out, page, nil
}

func (s *Service) view(ctx context.Context, d supportdb.Dispute) (DisputeView, error) {
	c, err := s.customer(ctx, s.q, d.UserID)
	if err != nil {
		return DisputeView{}, err
	}
	t, err := s.q.GetTransactionAny(ctx, d.TransactionID)
	if err != nil {
		return DisputeView{}, fmt.Errorf("load transaction: %w", err)
	}
	return DisputeView{Dispute: d, Customer: c, Transaction: t}, nil
}

// DisputeForStaff loads any dispute.
func (s *Service) DisputeForStaff(ctx context.Context, id uuid.UUID) (DisputeView, error) {
	d, err := s.q.GetDisputeAny(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return DisputeView{}, ErrDisputeNotFound
	}
	if err != nil {
		return DisputeView{}, fmt.Errorf("load dispute: %w", err)
	}
	return s.view(ctx, d)
}

// DisputeJSON is the contract's Dispute for a staff view.
func (s *Service) DisputeJSON(ctx context.Context, d supportdb.Dispute) (api.Dispute, error) {
	return s.disputeJSON(ctx, s.q, d)
}

// Reviewer identifies the staff member acting, for the audit log and the case.
type Reviewer struct {
	ID    uuid.UUID
	Actor audit.Actor
}

// StartReview moves a newly submitted dispute under review. Opening a case that is already under
// review, or closed, changes nothing.
func (s *Service) StartReview(ctx context.Context, id uuid.UUID, r Reviewer) error {
	now := s.now().UTC()
	return s.inTx(ctx, func(tx pgx.Tx, q *supportdb.Queries) error {
		d, err := q.LockDispute(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrDisputeNotFound
		}
		if err != nil {
			return fmt.Errorf("lock dispute: %w", err)
		}
		if d.Status != "submitted" {
			return nil
		}
		out, err := q.SetDisputeStatus(ctx, supportdb.SetDisputeStatusParams{ID: id, Status: "under_review", ReviewerID: &r.ID})
		if err != nil {
			return fmt.Errorf("start review: %w", err)
		}
		if err := s.event(ctx, q, id, "under_review", "Under review", "", now); err != nil {
			return err
		}
		return emitDispute(ctx, tx, out)
	})
}

// Decision is a reviewer's ruling.
type Decision struct {
	DisputeID uuid.UUID
	// Outcome is "refund", "decline" or "request_info".
	Outcome string
	// Note is shown to the customer.
	Note string
	// Refund is required for "refund": at most the disputed amount, in its currency.
	Refund   *money.Money
	Reviewer Reviewer
}

// Decide applies a ruling. A refund posts through the ledger (from the suspense account, the
// bank fronting the money while it chases the merchant) and adds a history line to the
// customer's account in the same transaction, so the dispute is never "refunded" without the
// money, nor the money without the dispute.
func (s *Service) Decide(ctx context.Context, d Decision) (supportdb.Dispute, error) {
	note := strings.TrimSpace(d.Note)
	if n := utf8.RuneCountInString(note); n < 5 || n > 1000 {
		return supportdb.Dispute{}, problem.Validation(problem.Field("/note", "length", "Tell the customer why, in 5 to 1,000 characters."))
	}
	if !slices.Contains([]string{"refund", "decline", "request_info"}, d.Outcome) {
		return supportdb.Dispute{}, problem.Validation(problem.Field("/outcome", "invalid", "Choose refund, decline or request_info."))
	}
	if d.Outcome == "refund" && (d.Refund == nil || !d.Refund.IsPositive()) {
		return supportdb.Dispute{}, problem.Validation(problem.Field("/refund_amount", "required", "Say how much to refund."))
	}
	var out supportdb.Dispute
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var err error
		out, err = s.DecideIn(ctx, tx, d)
		return err
	})
	return out, err
}

// DecideIn is Decide inside the caller's transaction, for a ruling that waits for a second staff
// member (maker-checker): the refund posts in the approval's own transaction, so the approval
// is only "approved" if the money moved.
func (s *Service) DecideIn(ctx context.Context, tx pgx.Tx, d Decision) (supportdb.Dispute, error) {
	note := strings.TrimSpace(d.Note)
	now := s.now().UTC()
	q := s.q.WithTx(tx)
	var out supportdb.Dispute
	cur, err := q.LockDispute(ctx, d.DisputeID)
	if errors.Is(err, pgx.ErrNoRows) {
		return supportdb.Dispute{}, ErrDisputeNotFound
	}
	if err != nil {
		return supportdb.Dispute{}, fmt.Errorf("lock dispute: %w", err)
	}
	if !slices.Contains(openStatuses, cur.Status) {
		return supportdb.Dispute{}, ErrDisputeClosed
	}
	switch d.Outcome {
	case "decline":
		out, err = q.SetDisputeStatus(ctx, supportdb.SetDisputeStatusParams{ID: cur.ID, Status: "resolved_declined", ResolutionNote: &note, ResolvedAt: &now, ReviewerID: &d.Reviewer.ID})
		if err == nil {
			err = s.event(ctx, q, cur.ID, "resolved_declined", "Dispute closed without a refund", note, now)
		}
	case "request_info":
		out, err = q.SetDisputeStatus(ctx, supportdb.SetDisputeStatusParams{ID: cur.ID, Status: "awaiting_customer", ResolutionNote: &note, ReviewerID: &d.Reviewer.ID})
		if err == nil {
			err = s.event(ctx, q, cur.ID, "awaiting_customer", "We need more from you", note, now)
		}
	case "refund":
		out, err = s.refund(ctx, tx, q, cur, *d.Refund, note, d.Reviewer.ID, now)
	}
	if err != nil {
		return supportdb.Dispute{}, err
	}
	if _, err := audit.Append(ctx, tx, audit.Input{
		Actor: d.Reviewer.Actor, Action: "dispute." + d.Outcome, ResourceType: "dispute", ResourceID: cur.ID.String(),
		Metadata: map[string]any{"case": cur.CaseNumber},
	}, now); err != nil {
		return supportdb.Dispute{}, err
	}
	if err := emitDispute(ctx, tx, out); err != nil {
		return supportdb.Dispute{}, err
	}
	return out, nil
}

func (s *Service) refund(ctx context.Context, tx pgx.Tx, q *supportdb.Queries, cur supportdb.Dispute, amount money.Money, note string, reviewer uuid.UUID, now time.Time) (supportdb.Dispute, error) {
	t, err := q.GetTransactionAny(ctx, cur.TransactionID)
	if err != nil {
		return supportdb.Dispute{}, fmt.Errorf("load transaction: %w", err)
	}
	if string(amount.Currency()) != t.Currency {
		return supportdb.Dispute{}, problem.Validation(problem.Field("/refund_amount", "currency", "Refund in the currency of the transaction ("+t.Currency+")."))
	}
	if amount.Amount() > t.AmountMinor {
		return supportdb.Dispute{}, problem.Validation(problem.Field("/refund_amount", "too_large", "A refund cannot be more than the disputed amount."))
	}
	src, err := ledger.SystemAccount(ctx, tx, ledger.KindSuspense, t.Currency)
	if err != nil {
		return supportdb.Dispute{}, err
	}
	posted, err := ledger.Post(ctx, tx, ledger.Entry{
		Kind: "dispute_refund", Reference: cur.CaseNumber, IdempotencyKey: "dispute-refund:" + cur.ID.String(),
		Metadata: map[string]any{"dispute_id": cur.ID.String(), "transaction_id": cur.TransactionID.String()},
		Legs:     []ledger.Leg{ledger.Debit(src.ID, amount), ledger.Credit(t.AccountID, amount)},
	})
	if err != nil {
		return supportdb.Dispute{}, fmt.Errorf("post refund: %w", err)
	}
	line, err := accounts.Record(ctx, tx, accounts.Line{
		UserID: cur.UserID, AccountID: t.AccountID, Type: "dispute_refund", Direction: "credit", Status: "completed",
		Amount: amount, Entry: &posted, Narration: "Refund for " + cur.CaseNumber, Reference: cur.CaseNumber, Category: "other",
		Counterparty: api.Counterparty{Name: "Nem Bank disputes"}, At: now,
	})
	if err != nil {
		return supportdb.Dispute{}, err
	}
	minor, cur2 := amount.Amount(), string(amount.Currency())
	out, err := q.SetDisputeRefund(ctx, supportdb.SetDisputeRefundParams{
		ID: cur.ID, ResolutionNote: &note, ResolvedAt: &now, ReviewerID: &reviewer, RefundMinor: &minor, RefundCurrency: &cur2, RefundTransactionID: &line.ID,
	})
	if err != nil {
		return supportdb.Dispute{}, fmt.Errorf("record refund: %w", err)
	}
	return out, s.event(ctx, q, cur.ID, "resolved_refunded", "Refunded", note, now)
}
