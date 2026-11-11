package kyc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/audit"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/kyc/kycdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/pagination"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// SubmitRequest is a Tier 3 submission (KYC-3).
type SubmitRequest struct {
	IDType      string
	IDNumber    string
	IDExpiry    *time.Time
	DocumentIDs []uuid.UUID
	Address     api.Address
}

var (
	errExpired    = problem.Validation(problem.Field("/id_expiry_date", "expired", "This ID has expired. Use one that is still valid."))
	errNeedID     = problem.Validation(problem.Field("/document_ids", "required", "Add a clear photo of your ID."))
	errNeedSelfie = problem.Validation(problem.Field("/document_ids", "required", "Add a clear selfie."))
	errBadDocs    = problem.Validation(problem.Field("/document_ids", "invalid", "One of these documents is not yours or does not exist."))
	// ErrNotPending is the 409 for deciding a submission that is not waiting for review.
	ErrNotPending = problem.New(http.StatusConflict, "invalid_state", "This submission has already been decided")
)

// Submit sends the customer's Tier 3 documents for review. They must be Tier 2 already; one
// submission waits at a time. The ID number is stored encrypted like the BVN, never with the
// submission, and the customer is told the outcome by notification and a kyc.updated event.
func (s *Service) Submit(ctx context.Context, req SubmitRequest) (api.KycSubmission, error) {
	p, err := principal(ctx)
	if err != nil {
		return api.KycSubmission{}, err
	}
	number, err := normalize(IDDocument, req.IDNumber)
	if err != nil {
		return api.KycSubmission{}, problem.Validation(problem.Field("/id_number", "bad_format", "This ID number is not in the expected format."))
	}
	now := s.now().UTC()
	if req.IDExpiry != nil && req.IDExpiry.Before(now.Truncate(24*time.Hour)) {
		return api.KycSubmission{}, errExpired
	}
	addr, err := json.Marshal(req.Address)
	if err != nil {
		return api.KycSubmission{}, fmt.Errorf("encode address: %w", err)
	}
	id, err := uuid.NewV7()
	if err != nil {
		return api.KycSubmission{}, fmt.Errorf("submission id: %w", err)
	}

	var out kycdb.KycSubmission
	err = s.inTx(ctx, func(tx pgx.Tx, q *kycdb.Queries) error {
		u, err := q.LockUserKyc(ctx, p.UserID)
		if err != nil {
			return fmt.Errorf("lock customer: %w", err)
		}
		switch {
		case u.KycTier >= 3:
			return errTier3Already
		case u.KycTier < 2:
			return errTierRequired
		case u.KycStatus == "pending_review":
			return errPendingReview
		}
		if err := s.checkDocuments(ctx, q, p.UserID, req.DocumentIDs); err != nil {
			return err
		}
		if err := s.ids.Save(ctx, tx, p.UserID, IDDocument, number); err != nil {
			return err
		}
		out, err = q.InsertSubmission(ctx, kycdb.InsertSubmissionParams{
			ID: id, UserID: p.UserID, IDType: req.IDType, IDExpiryDate: req.IDExpiry, Address: addr, DocumentIds: req.DocumentIDs, SubmittedAt: now,
		})
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.ConstraintName == "kyc_submissions_one_pending" {
			return errPendingReview
		}
		if err != nil {
			return fmt.Errorf("insert submission: %w", err)
		}
		if err := q.SetUserKyc(ctx, kycdb.SetUserKycParams{Tier: u.KycTier, Status: "pending_review", UserID: p.UserID}); err != nil {
			return fmt.Errorf("mark pending: %w", err)
		}
		if err := s.audit(ctx, tx, audit.Customer(p.UserID), "kyc.submit", out.ID.String(), map[string]any{"id_type": req.IDType, "documents": len(req.DocumentIDs)}); err != nil {
			return err
		}
		return s.emitUpdated(ctx, tx, p.UserID, int(u.KycTier), "pending_review", &out)
	})
	if err != nil {
		return api.KycSubmission{}, err
	}
	return SubmissionJSON(out), nil
}

// checkDocuments requires every document to be the caller's, and an ID photo and a selfie
// among them that were not rejected by the quality check.
func (s *Service) checkDocuments(ctx context.Context, q *kycdb.Queries, userID uuid.UUID, ids []uuid.UUID) error {
	docs, err := q.ListDocumentsByIDs(ctx, ids)
	if err != nil {
		return fmt.Errorf("load documents: %w", err)
	}
	unique := map[uuid.UUID]bool{}
	for _, id := range ids {
		unique[id] = true
	}
	if len(docs) != len(unique) {
		return errBadDocs
	}
	var haveID, haveSelfie bool
	for _, d := range docs {
		if d.UserID != userID {
			return errBadDocs
		}
		if d.Status == "rejected" {
			continue
		}
		haveID = haveID || d.Kind == "id_front"
		haveSelfie = haveSelfie || d.Kind == "selfie"
	}
	switch {
	case !haveID:
		return errNeedID
	case !haveSelfie:
		return errNeedSelfie
	}
	return nil
}

// Submission is the caller's own submission.
func (s *Service) Submission(ctx context.Context, id uuid.UUID) (api.KycSubmission, error) {
	p, err := principal(ctx)
	if err != nil {
		return api.KycSubmission{}, err
	}
	r, err := s.q.GetSubmission(ctx, kycdb.GetSubmissionParams{ID: id, UserID: p.UserID})
	if errors.Is(err, pgx.ErrNoRows) {
		return api.KycSubmission{}, ErrSubmissionNotFound
	}
	if err != nil {
		return api.KycSubmission{}, fmt.Errorf("load submission: %w", err)
	}
	return SubmissionJSON(r), nil
}

// ---------------------------------------------------------------- review (ADM-4)

// The staff-facing methods below take the reviewer as an argument: the console's HTTP
// operations (T30.5) authenticate staff and call them. Nothing here trusts a caller's role;
// the contract's x-roles check is what gates the route.

// Review is a submission with what a reviewer needs to decide it.
type Review struct {
	Submission kycdb.KycSubmission
	Customer   Customer
	Documents  []kycdb.KycDocument
	// IDLast4 is the end of the ID number; the number itself stays encrypted.
	IDLast4 string
	Checks  []kycdb.KycIdentityCheck
}

// Customer is who a submission belongs to.
type Customer struct {
	ID   uuid.UUID
	Name string
}

// QueueItem is one row of the review queue.
type QueueItem struct {
	Submission   kycdb.KycSubmission
	Customer     Customer
	WaitingHours int
}

// Queue lists submissions with a status, oldest first, so nobody waits longer than they must.
func (s *Service) Queue(ctx context.Context, status string, cursor *string, limit *int) ([]QueueItem, api.PageInfo, error) {
	after, err := pagination.Decode(cursor)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	n := pagination.Limit(limit)
	rows, err := s.q.ListSubmissions(ctx, kycdb.ListSubmissionsParams{
		Status: status, AfterTime: after.Time, AfterID: after.ID, PageSize: int32(n + 1), //nolint:gosec // n is at most 100
	})
	if err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("list submissions: %w", err)
	}
	rows, page := pagination.Page(rows, n, func(r kycdb.KycSubmission) pagination.Cursor {
		return pagination.Cursor{Time: r.SubmittedAt, ID: r.ID}
	})
	now := s.now()
	out := make([]QueueItem, len(rows))
	for i, r := range rows {
		c, err := s.customer(ctx, s.q, r.UserID)
		if err != nil {
			return nil, api.PageInfo{}, err
		}
		out[i] = QueueItem{Submission: r, Customer: c, WaitingHours: int(now.Sub(r.SubmittedAt).Hours())}
	}
	return out, page, nil
}

func (s *Service) customer(ctx context.Context, q *kycdb.Queries, id uuid.UUID) (Customer, error) {
	u, err := q.GetUserKyc(ctx, id)
	if err != nil {
		return Customer{}, fmt.Errorf("load customer: %w", err)
	}
	return Customer{ID: id, Name: u.FirstName + " " + u.LastName}, nil
}

// GetReview loads a submission for review. Opening photos is a separate, audited step
// (OpenDocument), so merely viewing the case reveals no image.
func (s *Service) GetReview(ctx context.Context, id uuid.UUID) (Review, error) {
	sub, err := s.q.GetSubmissionAny(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Review{}, ErrSubmissionNotFound
	}
	if err != nil {
		return Review{}, fmt.Errorf("load submission: %w", err)
	}
	c, err := s.customer(ctx, s.q, sub.UserID)
	if err != nil {
		return Review{}, err
	}
	docs, err := s.q.ListDocumentsByIDs(ctx, sub.DocumentIds)
	if err != nil {
		return Review{}, fmt.Errorf("load documents: %w", err)
	}
	checks, err := s.q.ListIdentityChecks(ctx, sub.UserID)
	if err != nil {
		return Review{}, fmt.Errorf("load checks: %w", err)
	}
	last4, err := s.ids.Last4(ctx, s.pool, sub.UserID, IDDocument)
	if err != nil && !errors.Is(err, ErrNoIdentifier) {
		return Review{}, err
	}
	return Review{Submission: sub, Customer: c, Documents: docs, IDLast4: last4, Checks: checks}, nil
}

// OpenDocument returns a submission's photo to a reviewer and writes an audit entry for it:
// who looked at whose ID, and when. The document must belong to a submission under review.
func (s *Service) OpenDocument(ctx context.Context, reviewer audit.Actor, submissionID, documentID uuid.UUID) (Document, error) {
	sub, err := s.q.GetSubmissionAny(ctx, submissionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Document{}, ErrSubmissionNotFound
	}
	if err != nil {
		return Document{}, fmt.Errorf("load submission: %w", err)
	}
	if !slices.Contains(sub.DocumentIds, documentID) {
		return Document{}, ErrDocumentNotFound
	}
	row, err := s.q.GetDocumentAny(ctx, documentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Document{}, ErrDocumentNotFound
	}
	if err != nil {
		return Document{}, fmt.Errorf("load document: %w", err)
	}
	doc, err := s.open(ctx, row)
	if err != nil {
		return Document{}, err
	}
	err = s.inTx(ctx, func(tx pgx.Tx, _ *kycdb.Queries) error {
		return s.audit(ctx, tx, reviewer, "kyc.document_view", submissionID.String(), map[string]any{"document_id": documentID.String(), "kind": row.Kind})
	})
	return doc, err
}

// Decision is a reviewer's ruling on one submission.
type Decision struct {
	SubmissionID uuid.UUID
	// Outcome is "approve", "reject" or "resubmit".
	Outcome string
	// Reason is shown to the customer; required unless approving.
	Reason string
	// ResubmitDocuments names the photos to send again; required for "resubmit".
	ResubmitDocuments []string
	// Reviewer is the staff member, for the audit log; ReviewerID is their ID.
	Reviewer   audit.Actor
	ReviewerID uuid.UUID
}

// Decide applies a ruling. Approving makes the customer Tier 3; the other two leave their tier
// and give a reason they can act on. The customer hears by event and notification.
func (s *Service) Decide(ctx context.Context, d Decision) (kycdb.KycSubmission, error) {
	var status string
	switch d.Outcome {
	case "approve":
		status = "approved"
	case "reject":
		status = "rejected"
	case "resubmit":
		status = "resubmit"
	default:
		return kycdb.KycSubmission{}, problem.Validation(problem.Field("/decision", "invalid", "Choose approve, reject or resubmit."))
	}
	reason := strings.TrimSpace(d.Reason)
	if status != "approved" && utf8.RuneCountInString(reason) < 5 {
		return kycdb.KycSubmission{}, problem.Validation(problem.Field("/reason", "required", "Tell the customer why, in a few words."))
	}
	if status == "resubmit" && len(d.ResubmitDocuments) == 0 {
		return kycdb.KycSubmission{}, problem.Validation(problem.Field("/resubmit_documents", "required", "Say which photos to send again."))
	}
	for _, k := range d.ResubmitDocuments {
		if !slices.Contains([]string{"id_front", "id_back", "selfie", "proof_of_address"}, k) {
			return kycdb.KycSubmission{}, problem.Validation(problem.Field("/resubmit_documents", "invalid", "Unknown document kind."))
		}
	}

	var out kycdb.KycSubmission
	now := s.now().UTC()
	err := s.inTx(ctx, func(tx pgx.Tx, q *kycdb.Queries) error {
		cur, err := q.LockSubmission(ctx, d.SubmissionID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrSubmissionNotFound
		}
		if err != nil {
			return fmt.Errorf("lock submission: %w", err)
		}
		if cur.Status != "pending_review" {
			return ErrNotPending
		}
		u, err := q.LockUserKyc(ctx, cur.UserID)
		if err != nil {
			return fmt.Errorf("lock customer: %w", err)
		}
		var why *string
		if reason != "" {
			why = &reason
		}
		resubmit := []string{}
		if status == "resubmit" {
			resubmit = d.ResubmitDocuments
		}
		out, err = q.DecideSubmission(ctx, kycdb.DecideSubmissionParams{
			Status: status, ReviewedAt: &now, ReviewerID: &d.ReviewerID, RejectionReason: why, ResubmitDocuments: resubmit, ID: cur.ID,
		})
		if err != nil {
			return fmt.Errorf("decide submission: %w", err)
		}
		tier := u.KycTier
		if status == "approved" {
			tier = 3
		}
		if err := q.SetUserKyc(ctx, kycdb.SetUserKycParams{Tier: tier, Status: status, UserID: cur.UserID}); err != nil {
			return fmt.Errorf("update customer: %w", err)
		}
		if err := s.audit(ctx, tx, d.Reviewer, "kyc."+d.Outcome, cur.ID.String(), map[string]any{"customer": cur.UserID.String()}); err != nil {
			return err
		}
		return s.emitUpdated(ctx, tx, cur.UserID, int(tier), status, &out)
	})
	return out, err
}
