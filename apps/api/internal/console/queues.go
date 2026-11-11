package console

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/admin"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/audit"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/console/consoledb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/kyc"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/kyc/kycdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/pagination"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/support"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers"
)

var errOverrideExpired = problem.Conflict("The override's expiry has passed, so it can no longer be approved.")

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }

// ---------------------------------------------------------------- KYC review (ADM-4)

// DocumentsPath serves a KYC photo to a reviewer from a short-lived signed link. The link names
// the staff member it was made for, so opening it writes an audit entry with the right name.
const DocumentsPath = "/v1/admin/kyc/documents/:submission/:document"

const docLinkLifetime = 5 * time.Minute

func (s *Service) signDoc(staffID, submission, document uuid.UUID, exp int64) string {
	m := hmac.New(sha256.New, s.linkKey)
	m.Write([]byte("nem kyc review link v1"))
	m.Write(staffID[:])
	m.Write(submission[:])
	m.Write(document[:])
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], uint64(exp)) //nolint:gosec // a unix time, positive
	m.Write(b[:])
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func (s *Service) docURL(staffID, submission, document uuid.UUID) string {
	exp := s.now().Add(docLinkLifetime).Unix()
	return "/v1/admin/kyc/documents/" + submission.String() + "/" + document.String() +
		"?staff=" + staffID.String() + "&exp=" + strconv.FormatInt(exp, 10) + "&sig=" + s.signDoc(staffID, submission, document, exp)
}

// ServeDocument streams a photo for a valid link. Anything wrong with the link is a plain 404.
func (s *Service) ServeDocument(w http.ResponseWriter, r *http.Request, rawSubmission, rawDocument, rawStaff, rawExp, sig string) {
	notFound := func() { http.NotFound(w, r) }
	sub, err1 := uuid.Parse(rawSubmission)
	doc, err2 := uuid.Parse(rawDocument)
	who, err3 := uuid.Parse(rawStaff)
	exp, err4 := strconv.ParseInt(rawExp, 10, 64)
	if err1 != nil || err2 != nil || err3 != nil || err4 != nil || s.now().Unix() > exp {
		notFound()
		return
	}
	if !hmac.Equal([]byte(sig), []byte(s.signDoc(who, sub, doc, exp))) {
		notFound()
		return
	}
	ref, err := s.q.GetStaffRef(r.Context(), who)
	if err != nil {
		notFound()
		return
	}
	d, err := s.kyc.OpenDocument(r.Context(), actorOf(admin.Principal{StaffID: ref.ID, Name: ref.Name}), sub, doc)
	if err != nil {
		notFound()
		return
	}
	w.Header().Set("Content-Type", d.ContentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	_, _ = w.Write(d.Data)
}

func (s *Service) staffRef(ctx context.Context, id *uuid.UUID) (*api.StaffRef, error) {
	if id == nil {
		return nil, nil
	}
	r, err := s.q.GetStaffRef(ctx, *id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("load staff: %w", err)
	}
	return &api.StaffRef{Id: r.ID, Name: r.Name}, nil
}

// KycReviews is the review queue, oldest first.
func (s *Service) KycReviews(ctx context.Context, status *string, cursor *string, limit *int) (api.KycReviewPage, error) {
	if _, err := staff(ctx); err != nil {
		return api.KycReviewPage{}, err
	}
	st := "pending_review"
	if status != nil {
		st = *status
	}
	items, page, err := s.kyc.Queue(ctx, st, cursor, limit)
	if err != nil {
		return api.KycReviewPage{}, err
	}
	out := api.KycReviewPage{Page: page, Data: make([]struct {
		Customer     api.CustomerSummary `json:"customer"`
		Submission   api.KycSubmission   `json:"submission"`
		WaitingHours int                 `json:"waiting_hours"`
	}, len(items))}
	for i, it := range items {
		c, err := s.customerSummary(ctx, it.Customer.ID)
		if err != nil {
			return api.KycReviewPage{}, err
		}
		out.Data[i].Customer, out.Data[i].Submission, out.Data[i].WaitingHours = c, kyc.SubmissionJSON(it.Submission), it.WaitingHours
	}
	return out, nil
}

func nameMatchOf(c kycdb.KycIdentityCheck) api.NameMatch {
	return api.NameMatch{Result: api.NameMatchResult(c.NameResult), Confidence: c.NameConfidence}
}

// KycReview is one submission with what the reviewer needs. Photos come as signed links; opening
// one is what writes the audit entry, not loading this page.
func (s *Service) KycReview(ctx context.Context, id uuid.UUID) (api.KycReview, error) {
	p, err := staff(ctx)
	if err != nil {
		return api.KycReview{}, err
	}
	rv, err := s.kyc.GetReview(ctx, id)
	if err != nil {
		return api.KycReview{}, err
	}
	cust, err := s.customerSummary(ctx, rv.Customer.ID)
	if err != nil {
		return api.KycReview{}, err
	}
	out := api.KycReview{
		Submission: kyc.SubmissionJSON(rv.Submission), Customer: cust, IdType: rv.Submission.IDType,
		IdNumberMasked: "•••• " + rv.IDLast4, IdentityChecks: []api.IdentityVerification{},
	}
	if rv.IDLast4 == "" {
		out.IdNumberMasked = "•••• ••••"
	}
	if err := json.Unmarshal(rv.Submission.Address, &out.Address); err != nil {
		return api.KycReview{}, fmt.Errorf("decode address: %w", err)
	}
	// The contract's document is an anonymous struct (a photo plus its signed link), so it is
	// filled in through JSON rather than by naming the generated type.
	docs := make([]map[string]any, 0, len(rv.Documents))
	for _, d := range rv.Documents {
		doc := map[string]any{
			"id": d.ID, "kind": d.Kind, "status": d.Status, "uploaded_at": d.CreatedAt.UTC(), "url": s.docURL(p.StaffID, id, d.ID),
		}
		if len(d.QualityIssues) > 0 {
			doc["quality_issues"] = d.QualityIssues
		}
		docs = append(docs, doc)
	}
	raw, err := json.Marshal(docs)
	if err != nil {
		return api.KycReview{}, fmt.Errorf("encode documents: %w", err)
	}
	if err := json.Unmarshal(raw, &out.Documents); err != nil {
		return api.KycReview{}, fmt.Errorf("decode documents: %w", err)
	}
	for _, c := range rv.Checks {
		v := api.IdentityVerification{
			Type: api.IdentityVerificationType(c.Kind), Verified: c.Verified, NameMatch: nameMatchOf(c), Sandbox: c.Provider == "sandbox", Tier: 2,
		}
		if c.DobMatch.Valid {
			b := c.DobMatch.Bool
			v.DateOfBirthMatch = &b
		}
		out.IdentityChecks = append(out.IdentityChecks, v)
	}
	if out.Reviewer, err = s.staffRef(ctx, rv.Submission.ReviewerID); err != nil {
		return api.KycReview{}, err
	}
	return out, nil
}

// DecideKyc approves, rejects or asks for new photos. Approving makes the customer Tier 3.
func (s *Service) DecideKyc(ctx context.Context, id uuid.UUID, req api.KycDecisionRequest) (api.KycReview, error) {
	p, err := staff(ctx)
	if err != nil {
		return api.KycReview{}, err
	}
	d := kyc.Decision{SubmissionID: id, Outcome: string(req.Decision), Reviewer: actorOf(p), ReviewerID: p.StaffID}
	if req.Reason != nil {
		d.Reason = *req.Reason
	}
	if req.ResubmitDocuments != nil {
		for _, k := range *req.ResubmitDocuments {
			d.ResubmitDocuments = append(d.ResubmitDocuments, string(k))
		}
	}
	if _, err := s.kyc.Decide(ctx, d); err != nil {
		return api.KycReview{}, err
	}
	return s.KycReview(ctx, id)
}

// ---------------------------------------------------------------- fraud cases (ADM-5)

var (
	errCaseTaken = problem.Conflict("Someone else is already reviewing this case, or it is closed.")
	errNoCase    = problem.NotFound("Fraud case")
)

func (s *Service) fraudCase(ctx context.Context, id uuid.UUID) (api.FraudCase, error) {
	row, err := s.q.GetFraudCase(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.FraudCase{}, errNoCase
	}
	if err != nil {
		return api.FraudCase{}, fmt.Errorf("load fraud case: %w", err)
	}
	v, err := s.transfers.StaffView(ctx, id)
	if err != nil {
		return api.FraudCase{}, err
	}
	tj, err := transfers.TransferJSON(v)
	if err != nil {
		return api.FraudCase{}, err
	}
	cust, err := s.customerSummary(ctx, row.UserID)
	if err != nil {
		return api.FraudCase{}, err
	}
	out := api.FraudCase{
		Id: id, Status: api.FraudCaseStatus(row.Status), Transfer: tj, Customer: cust, Note: row.Note, ClosedAt: nil,
		CreatedAt: row.TransferCreatedAt.UTC(),
	}
	if tj.Risk != nil {
		out.Risk = *tj.Risk
	}
	if row.AssigneeID != nil && row.AssigneeName != nil {
		out.Assignee = &api.StaffRef{Id: *row.AssigneeID, Name: *row.AssigneeName}
	}
	if row.Label != nil {
		l := api.FraudLabel(*row.Label)
		out.Label = &l
	}
	if row.ClosedAt != nil {
		t := row.ClosedAt.UTC()
		out.ClosedAt = &t
	}
	now := s.now()
	sig, err := s.q.FraudSignals(ctx, consoledb.FraudSignalsParams{Now: now, TransferID: id, UserID: row.UserID})
	if err != nil {
		return api.FraudCase{}, fmt.Errorf("load signals: %w", err)
	}
	avg := apiMoney(sig.AverageMinor, v.Currency)
	age := int(sig.DeviceAgeHours)
	t24 := int(sig.TransfersLast24h)
	out.Signals = &struct {
		AverageTransfer     *api.Money `json:"average_transfer,omitempty"`
		BeneficiaryAgeHours *int       `json:"beneficiary_age_hours,omitempty"`
		DeviceAgeHours      *int       `json:"device_age_hours,omitempty"`
		TransfersLast24h    *int       `json:"transfers_last_24h,omitempty"`
	}{AverageTransfer: &avg, DeviceAgeHours: &age, TransfersLast24h: &t24}
	if h, err := s.q.BeneficiaryAgeHours(ctx, consoledb.BeneficiaryAgeHoursParams{Now: now, UserID: row.UserID, TransferID: id}); err == nil {
		hh := int(h)
		out.Signals.BeneficiaryAgeHours = &hh
	}
	return out, nil
}

// FraudCases lists held transfers (open and in review, highest risk first) or closed cases.
func (s *Service) FraudCases(ctx context.Context, p api.ListFraudCasesParams) (api.FraudCasePage, error) {
	me, err := staff(ctx)
	if err != nil {
		return api.FraudCasePage{}, err
	}
	status := "open"
	if p.Status != nil {
		status = string(*p.Status)
	}
	n := pagination.Limit(p.Limit)
	args := consoledb.ListFraudCasesParams{Status: status, PageSize: int32(n + 1), AfterScore: 2, AfterID: uuid.Max, AfterTime: time.Now().Add(24 * time.Hour)} //nolint:gosec // n is at most 100
	if cur, err := pagination.Decode(p.Cursor); err != nil {
		return api.FraudCasePage{}, err
	} else if !cur.IsZero() {
		args.AfterID, args.AfterTime = cur.ID, cur.Time
		// An open or in-review case pages by risk score, which the cursor carries as its time
		// (seconds since the epoch, scaled): see scoreOf and cursorFor.
		args.AfterScore = scoreOf(cur.Time)
	}
	rows, err := s.q.ListFraudCases(ctx, args)
	if err != nil {
		return api.FraudCasePage{}, fmt.Errorf("list fraud cases: %w", err)
	}
	rows, page := pagination.Page(rows, n, func(r consoledb.ListFraudCasesRow) pagination.Cursor {
		if status == "open" || status == "in_review" {
			return pagination.Cursor{Time: cursorFor(r.Score), ID: r.TransferID}
		}
		return pagination.Cursor{Time: r.SortTime, ID: r.TransferID}
	})
	out := api.FraudCasePage{Page: page, Data: make([]api.FraudCase, 0, len(rows))}
	for _, r := range rows {
		c, err := s.fraudCase(ctx, r.TransferID)
		if err != nil {
			return api.FraudCasePage{}, err
		}
		if p.AssignedToMe != nil && *p.AssignedToMe && (c.Assignee == nil || c.Assignee.Id != me.StaffID) {
			continue
		}
		out.Data = append(out.Data, c)
	}
	return out, nil
}

// A cursor carries a time and an ID. The open queue sorts by risk score instead of time, so the
// score rides in the time field as microseconds after the epoch (score is 0 to 1, so millionths
// give six decimal places, more than the model's output needs).
func cursorFor(score float64) time.Time { return time.UnixMicro(int64(score * 1_000_000)).UTC() }

func scoreOf(t time.Time) float64 { return float64(t.UnixMicro()) / 1_000_000 }

// FraudCase is one case.
func (s *Service) FraudCase(ctx context.Context, id uuid.UUID) (api.FraudCase, error) {
	if _, err := staff(ctx); err != nil {
		return api.FraudCase{}, err
	}
	return s.fraudCase(ctx, id)
}

// AssignFraudCase takes a case for the signed-in reviewer. A case someone else holds, or that is
// closed, is a 409.
func (s *Service) AssignFraudCase(ctx context.Context, id uuid.UUID) (api.FraudCase, error) {
	p, err := staff(ctx)
	if err != nil {
		return api.FraudCase{}, err
	}
	err = s.inTx(ctx, func(tx pgx.Tx, q *consoledb.Queries) error {
		if _, err := q.AssignFraudCase(ctx, consoledb.AssignFraudCaseParams{StaffID: p.StaffID, Now: s.now(), TransferID: id}); errors.Is(err, pgx.ErrNoRows) {
			if _, gerr := q.GetFraudCase(ctx, id); errors.Is(gerr, pgx.ErrNoRows) {
				return errNoCase
			}
			return errCaseTaken
		} else if err != nil {
			return fmt.Errorf("assign fraud case: %w", err)
		}
		return s.record(ctx, tx, actorOf(p), "fraud.assign", "fraud_case", id.String(), nil)
	})
	if err != nil {
		return api.FraudCase{}, err
	}
	return s.fraudCase(ctx, id)
}

// DecideFraudCase releases or rejects a held transfer. The decision, the case file, the risk
// engine's label (the retraining feed) and the audit entry commit together.
func (s *Service) DecideFraudCase(ctx context.Context, id uuid.UUID, req api.FraudDecisionRequest) (api.FraudCase, error) {
	p, err := staff(ctx)
	if err != nil {
		return api.FraudCase{}, err
	}
	row, err := s.q.GetFraudCase(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.FraudCase{}, errNoCase
	}
	if err != nil {
		return api.FraudCase{}, fmt.Errorf("load fraud case: %w", err)
	}
	if row.AssigneeID != nil && *row.AssigneeID != p.StaffID {
		return api.FraudCase{}, errCaseTaken
	}
	release := req.Decision == "release"
	// The risk engine learns two classes; "unsure" teaches it nothing, so it is kept on the
	// case file only.
	var riskLabel *string
	switch req.Label {
	case api.FraudLabel("fraud"):
		riskLabel = ptr("fraud")
	case api.FraudLabel("legitimate"):
		riskLabel = ptr("legit")
	}
	status := "rejected"
	if release {
		status = "released"
	}
	now := s.now()
	err = s.transfers.DecideHeld(ctx, id, release, func(ctx context.Context, tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		if err := q.CloseFraudCase(ctx, consoledb.CloseFraudCaseParams{
			TransferID: id, Status: status, StaffID: &p.StaffID, Label: ptr(string(req.Label)), Note: req.Note, CustomerMessage: req.CustomerMessage, Now: now,
		}); err != nil {
			return fmt.Errorf("close fraud case: %w", err)
		}
		if riskLabel != nil {
			if err := q.LabelRisk(ctx, consoledb.LabelRiskParams{TransferID: id, Label: riskLabel, StaffID: &p.StaffID, Now: &now, Note: req.Note}); err != nil {
				return fmt.Errorf("label risk: %w", err)
			}
		}
		return s.record(ctx, tx, actorOf(p), "fraud."+string(req.Decision), "fraud_case", id.String(), map[string]any{"label": string(req.Label)})
	})
	if err != nil {
		return api.FraudCase{}, err
	}
	return s.fraudCase(ctx, id)
}

// ---------------------------------------------------------------- disputes (ADM-6)

func (s *Service) adminDispute(ctx context.Context, v support.DisputeView) (api.AdminDispute, error) {
	d, err := s.support.DisputeJSON(ctx, v.Dispute)
	if err != nil {
		return api.AdminDispute{}, err
	}
	cust, err := s.customerSummary(ctx, v.Dispute.UserID)
	if err != nil {
		return api.AdminDispute{}, err
	}
	tx, err := s.accounts.StaffTransactionDetail(ctx, v.Dispute.UserID, v.Dispute.TransactionID)
	if err != nil {
		return api.AdminDispute{}, err
	}
	out := api.AdminDispute{Dispute: d, Customer: cust, Transaction: tx}
	if out.Assignee, err = s.staffRef(ctx, v.Dispute.ReviewerID); err != nil {
		return api.AdminDispute{}, err
	}
	return out, nil
}

// Disputes lists disputes, oldest open first.
func (s *Service) Disputes(ctx context.Context, status *string, cursor *string, limit *int) (api.AdminDisputePage, error) {
	if _, err := staff(ctx); err != nil {
		return api.AdminDisputePage{}, err
	}
	st := ""
	if status != nil {
		st = *status
	}
	items, page, err := s.support.DisputeQueue(ctx, st, cursor, limit)
	if err != nil {
		return api.AdminDisputePage{}, err
	}
	out := api.AdminDisputePage{Page: page, Data: make([]api.AdminDispute, len(items))}
	for i, v := range items {
		if out.Data[i], err = s.adminDispute(ctx, v); err != nil {
			return api.AdminDisputePage{}, err
		}
	}
	return out, nil
}

// Dispute opens a dispute for review. Opening a newly submitted one moves it under review.
func (s *Service) Dispute(ctx context.Context, id uuid.UUID) (api.AdminDispute, error) {
	p, err := staff(ctx)
	if err != nil {
		return api.AdminDispute{}, err
	}
	if err := s.support.StartReview(ctx, id, support.Reviewer{ID: p.StaffID, Actor: actorOf(p)}); err != nil {
		return api.AdminDispute{}, err
	}
	v, err := s.support.DisputeForStaff(ctx, id)
	if err != nil {
		return api.AdminDispute{}, err
	}
	return s.adminDispute(ctx, v)
}

// DecideDispute rules on a dispute. A refund above the threshold waits for a second staff
// member (the approval is returned, answered 202); anything else applies at once.
func (s *Service) DecideDispute(ctx context.Context, id uuid.UUID, req api.DisputeDecisionRequest) (*api.AdminDispute, *api.ApprovalRequest, error) {
	p, err := staff(ctx)
	if err != nil {
		return nil, nil, err
	}
	d := support.Decision{DisputeID: id, Outcome: string(req.Outcome), Note: req.Note, Reviewer: support.Reviewer{ID: p.StaffID, Actor: actorOf(p)}}
	if req.Outcome == "refund" {
		if req.RefundAmount == nil {
			return nil, nil, problem.Validation(problem.Field("/refund_amount", "required", "Say how much to refund."))
		}
		amt, err := money.ParseMinor(req.RefundAmount.AmountMinor, string(req.RefundAmount.Currency))
		if err != nil || !amt.IsPositive() {
			return nil, nil, problem.Validation(problem.Field("/refund_amount", "invalid", "Give an amount above zero."))
		}
		d.Refund = &amt
		if amt.Currency() == money.NGN && amt.Amount() > s.refundApprovalMinor {
			v, err := s.support.DisputeForStaff(ctx, id)
			if err != nil {
				return nil, nil, err
			}
			if v.Dispute.Status != "submitted" && v.Dispute.Status != "under_review" && v.Dispute.Status != "awaiting_customer" {
				return nil, nil, problem.Conflict("This dispute is already closed.")
			}
			ap, err := s.propose(ctx, admin.Proposal{
				Action: admin.ActionDisputeRefund, Reason: req.Note, Summary: "Refund " + amt.String() + " for " + v.Dispute.CaseNumber,
				After: map[string]any{"dispute_id": id.String(), "amount_minor": req.RefundAmount.AmountMinor, "currency": string(req.RefundAmount.Currency), "note": req.Note},
			})
			return nil, &ap, err
		}
	}
	if _, err := s.support.Decide(ctx, d); err != nil {
		return nil, nil, err
	}
	v, err := s.support.DisputeForStaff(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	out, err := s.adminDispute(ctx, v)
	return &out, nil, err
}

// ---------------------------------------------------------------- support agent inbox (ADM-6)

func agentOf(p admin.Principal) support.Agent {
	return support.Agent{ID: p.StaffID, Name: p.Name, Actor: actorOf(p)}
}

func (s *Service) agentConversation(ctx context.Context, it support.AgentItem) (api.AgentConversation, error) {
	c, err := s.support.ConversationJSON(ctx, it.Conversation)
	if err != nil {
		return api.AgentConversation{}, err
	}
	cust, err := s.customerSummary(ctx, it.Conversation.UserID)
	if err != nil {
		return api.AgentConversation{}, err
	}
	return api.AgentConversation{Conversation: c, Customer: cust, WaitingMinutes: it.WaitingMinutes}, nil
}

// AgentConversations is the agent inbox, longest waiting first.
func (s *Service) AgentConversations(ctx context.Context, status *string, mine bool, cursor *string, limit *int) (api.AgentConversationPage, error) {
	p, err := staff(ctx)
	if err != nil {
		return api.AgentConversationPage{}, err
	}
	st := ""
	if status != nil {
		st = *status
	}
	var who *uuid.UUID
	if mine {
		who = &p.StaffID
	}
	items, page, err := s.support.AgentInbox(ctx, st, who, cursor, limit)
	if err != nil {
		return api.AgentConversationPage{}, err
	}
	out := api.AgentConversationPage{Page: page, Data: make([]api.AgentConversation, len(items))}
	for i, it := range items {
		if out.Data[i], err = s.agentConversation(ctx, it); err != nil {
			return api.AgentConversationPage{}, err
		}
	}
	return out, nil
}

// AgentMessages reads a customer chat.
func (s *Service) AgentMessages(ctx context.Context, id uuid.UUID, cursor *string, limit *int) (api.SupportMessagePage, error) {
	if _, err := staff(ctx); err != nil {
		return api.SupportMessagePage{}, err
	}
	msgs, page, err := s.support.AgentMessages(ctx, id, cursor, limit)
	if err != nil {
		return api.SupportMessagePage{}, err
	}
	return api.SupportMessagePage{Data: msgs, Page: page}, nil
}

// AgentReply answers a customer; an unassigned chat goes to whoever replies first.
func (s *Service) AgentReply(ctx context.Context, id uuid.UUID, body string) (api.SupportMessage, error) {
	p, err := staff(ctx)
	if err != nil {
		return api.SupportMessage{}, err
	}
	return s.support.Reply(ctx, id, agentOf(p), body)
}

// ResolveConversation closes a chat.
func (s *Service) ResolveConversation(ctx context.Context, id uuid.UUID) (api.AgentConversation, error) {
	p, err := staff(ctx)
	if err != nil {
		return api.AgentConversation{}, err
	}
	c, err := s.support.Resolve(ctx, id, agentOf(p))
	if err != nil {
		return api.AgentConversation{}, err
	}
	return s.agentConversation(ctx, support.AgentItem{Conversation: c})
}

var _ = accounts.Money
var _ = audit.System
