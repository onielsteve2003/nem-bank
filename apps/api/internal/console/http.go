package console

import (
	"context"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
)

// API adapts the service to the contract's strict server; the router embeds it next to the other
// domains. The contract's x-roles are checked by the request validator before any of these run.
// A nil *API answers 501.
type API struct{ svc *Service }

// NewAPI returns the staff console operations for the router.
func NewAPI(svc *Service) *API { return &API{svc: svc} }

func (a *API) off() bool { return a == nil }

func day(d *api.FromDate) *time.Time {
	if d == nil {
		return nil
	}
	t := d.Time
	return &t
}

// DocumentsHandler serves KYC photos from signed links (not a contract operation: the link is
// the credential, like attachment links).
func (a *API) DocumentsHandler(c *gin.Context) {
	if a.off() {
		c.Status(404)
		return
	}
	a.svc.ServeDocument(c.Writer, c.Request, c.Param("submission"), c.Param("document"), c.Query("staff"), c.Query("exp"), c.Query("sig"))
}

// GetAdminDashboard is GET /v1/admin/dashboard.
func (a *API) GetAdminDashboard(ctx context.Context, req api.GetAdminDashboardRequestObject) (api.GetAdminDashboardResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	var to *time.Time
	if req.Params.To != nil {
		t := req.Params.To.Time
		to = &t
	}
	d, err := a.svc.Dashboard(ctx, day(req.Params.From), to)
	if err != nil {
		return nil, err
	}
	return api.GetAdminDashboard200JSONResponse(d), nil
}

// SearchCustomers is GET /v1/admin/customers.
func (a *API) SearchCustomers(ctx context.Context, req api.SearchCustomersRequestObject) (api.SearchCustomersResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	rows, page, err := a.svc.SearchCustomers(ctx, req.Params.Q, req.Params.Cursor, req.Params.Limit)
	if err != nil {
		return nil, err
	}
	return api.SearchCustomers200JSONResponse{Data: rows, Page: page}, nil
}

// GetCustomer360 is GET /v1/admin/customers/{user_id}.
func (a *API) GetCustomer360(ctx context.Context, req api.GetCustomer360RequestObject) (api.GetCustomer360ResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	c, err := a.svc.Customer360(ctx, req.UserId)
	if err != nil {
		return nil, err
	}
	return api.GetCustomer360200JSONResponse(c), nil
}

// AddCustomerNote is POST /v1/admin/customers/{user_id}/notes.
func (a *API) AddCustomerNote(ctx context.Context, req api.AddCustomerNoteRequestObject) (api.AddCustomerNoteResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	n, err := a.svc.AddNote(ctx, req.UserId, req.Body.Body)
	if err != nil {
		return nil, err
	}
	return api.AddCustomerNote201JSONResponse(n), nil
}

// FreezeCustomer is POST /v1/admin/customers/{user_id}/freeze.
func (a *API) FreezeCustomer(ctx context.Context, req api.FreezeCustomerRequestObject) (api.FreezeCustomerResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	c, err := a.svc.Freeze(ctx, req.UserId, req.Body.Reason)
	if err != nil {
		return nil, err
	}
	return api.FreezeCustomer200JSONResponse(c), nil
}

// RequestCustomerUnfreeze is POST /v1/admin/customers/{user_id}/unfreeze.
func (a *API) RequestCustomerUnfreeze(ctx context.Context, req api.RequestCustomerUnfreezeRequestObject) (api.RequestCustomerUnfreezeResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	ap, err := a.svc.RequestUnfreeze(ctx, req.UserId, req.Body.Reason)
	if err != nil {
		return nil, err
	}
	return api.RequestCustomerUnfreeze202JSONResponse(ap), nil
}

// RequestLimitOverride is POST /v1/admin/customers/{user_id}/limit-overrides.
func (a *API) RequestLimitOverride(ctx context.Context, req api.RequestLimitOverrideRequestObject) (api.RequestLimitOverrideResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	ap, err := a.svc.RequestLimitOverride(ctx, req.UserId, *req.Body)
	if err != nil {
		return nil, err
	}
	return api.RequestLimitOverride202JSONResponse(ap), nil
}

// ListKycReviews is GET /v1/admin/kyc/reviews.
func (a *API) ListKycReviews(ctx context.Context, req api.ListKycReviewsRequestObject) (api.ListKycReviewsResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	var st *string
	if req.Params.Status != nil {
		s := string(*req.Params.Status)
		st = &s
	}
	p, err := a.svc.KycReviews(ctx, st, req.Params.Cursor, req.Params.Limit)
	if err != nil {
		return nil, err
	}
	return api.ListKycReviews200JSONResponse(p), nil
}

// GetKycReview is GET /v1/admin/kyc/reviews/{submission_id}.
func (a *API) GetKycReview(ctx context.Context, req api.GetKycReviewRequestObject) (api.GetKycReviewResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	r, err := a.svc.KycReview(ctx, req.SubmissionId)
	if err != nil {
		return nil, err
	}
	return api.GetKycReview200JSONResponse(r), nil
}

// DecideKycReview is POST /v1/admin/kyc/reviews/{submission_id}/decision.
func (a *API) DecideKycReview(ctx context.Context, req api.DecideKycReviewRequestObject) (api.DecideKycReviewResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	r, err := a.svc.DecideKyc(ctx, req.SubmissionId, *req.Body)
	if err != nil {
		return nil, err
	}
	return api.DecideKycReview200JSONResponse(r), nil
}

// ListFraudCases is GET /v1/admin/fraud/cases.
func (a *API) ListFraudCases(ctx context.Context, req api.ListFraudCasesRequestObject) (api.ListFraudCasesResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	p, err := a.svc.FraudCases(ctx, req.Params)
	if err != nil {
		return nil, err
	}
	return api.ListFraudCases200JSONResponse(p), nil
}

// GetFraudCase is GET /v1/admin/fraud/cases/{case_id}.
func (a *API) GetFraudCase(ctx context.Context, req api.GetFraudCaseRequestObject) (api.GetFraudCaseResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	c, err := a.svc.FraudCase(ctx, req.CaseId)
	if err != nil {
		return nil, err
	}
	return api.GetFraudCase200JSONResponse(c), nil
}

// AssignFraudCase is POST /v1/admin/fraud/cases/{case_id}/assign.
func (a *API) AssignFraudCase(ctx context.Context, req api.AssignFraudCaseRequestObject) (api.AssignFraudCaseResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	c, err := a.svc.AssignFraudCase(ctx, req.CaseId)
	if err != nil {
		return nil, err
	}
	return api.AssignFraudCase200JSONResponse(c), nil
}

// DecideFraudCase is POST /v1/admin/fraud/cases/{case_id}/decision.
func (a *API) DecideFraudCase(ctx context.Context, req api.DecideFraudCaseRequestObject) (api.DecideFraudCaseResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	c, err := a.svc.DecideFraudCase(ctx, req.CaseId, *req.Body)
	if err != nil {
		return nil, err
	}
	return api.DecideFraudCase200JSONResponse(c), nil
}

// ListAdminDisputes is GET /v1/admin/disputes.
func (a *API) ListAdminDisputes(ctx context.Context, req api.ListAdminDisputesRequestObject) (api.ListAdminDisputesResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	var st *string
	if req.Params.Status != nil {
		s := string(*req.Params.Status)
		st = &s
	}
	p, err := a.svc.Disputes(ctx, st, req.Params.Cursor, req.Params.Limit)
	if err != nil {
		return nil, err
	}
	return api.ListAdminDisputes200JSONResponse(p), nil
}

// GetAdminDispute is GET /v1/admin/disputes/{dispute_id}.
func (a *API) GetAdminDispute(ctx context.Context, req api.GetAdminDisputeRequestObject) (api.GetAdminDisputeResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	d, err := a.svc.Dispute(ctx, req.DisputeId)
	if err != nil {
		return nil, err
	}
	return api.GetAdminDispute200JSONResponse(d), nil
}

// DecideDispute is POST /v1/admin/disputes/{dispute_id}/decision.
func (a *API) DecideDispute(ctx context.Context, req api.DecideDisputeRequestObject) (api.DecideDisputeResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	d, ap, err := a.svc.DecideDispute(ctx, req.DisputeId, *req.Body)
	if err != nil {
		return nil, err
	}
	if ap != nil {
		return api.DecideDispute202JSONResponse(*ap), nil
	}
	return api.DecideDispute200JSONResponse(*d), nil
}

// ListAgentConversations is GET /v1/admin/support/conversations.
func (a *API) ListAgentConversations(ctx context.Context, req api.ListAgentConversationsRequestObject) (api.ListAgentConversationsResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	var st *string
	if req.Params.Status != nil {
		s := string(*req.Params.Status)
		st = &s
	}
	p, err := a.svc.AgentConversations(ctx, st, req.Params.AssignedToMe != nil && *req.Params.AssignedToMe, req.Params.Cursor, req.Params.Limit)
	if err != nil {
		return nil, err
	}
	return api.ListAgentConversations200JSONResponse(p), nil
}

// ListAgentMessages is GET /v1/admin/support/conversations/{conversation_id}/messages.
func (a *API) ListAgentMessages(ctx context.Context, req api.ListAgentMessagesRequestObject) (api.ListAgentMessagesResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	p, err := a.svc.AgentMessages(ctx, req.ConversationId, req.Params.Cursor, req.Params.Limit)
	if err != nil {
		return nil, err
	}
	return api.ListAgentMessages200JSONResponse(p), nil
}

// SendAgentMessage is POST /v1/admin/support/conversations/{conversation_id}/messages.
func (a *API) SendAgentMessage(ctx context.Context, req api.SendAgentMessageRequestObject) (api.SendAgentMessageResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	m, err := a.svc.AgentReply(ctx, req.ConversationId, req.Body.Body)
	if err != nil {
		return nil, err
	}
	return api.SendAgentMessage201JSONResponse(m), nil
}

// ResolveConversation is POST /v1/admin/support/conversations/{conversation_id}/resolve.
func (a *API) ResolveConversation(ctx context.Context, req api.ResolveConversationRequestObject) (api.ResolveConversationResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	c, err := a.svc.ResolveConversation(ctx, req.ConversationId)
	if err != nil {
		return nil, err
	}
	return api.ResolveConversation200JSONResponse(c), nil
}

// ListLedgerAccounts is GET /v1/admin/ledger/accounts.
func (a *API) ListLedgerAccounts(ctx context.Context, req api.ListLedgerAccountsRequestObject) (api.ListLedgerAccountsResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	rows, page, err := a.svc.LedgerAccounts(ctx, req.Params)
	if err != nil {
		return nil, err
	}
	return api.ListLedgerAccounts200JSONResponse{Data: rows, Page: page}, nil
}

// ListLedgerPostings is GET /v1/admin/ledger/accounts/{ledger_account_id}/postings.
func (a *API) ListLedgerPostings(ctx context.Context, req api.ListLedgerPostingsRequestObject) (api.ListLedgerPostingsResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	rows, page, err := a.svc.LedgerPostings(ctx, req.LedgerAccountId, req.Params)
	if err != nil {
		return nil, err
	}
	return api.ListLedgerPostings200JSONResponse{Data: rows, Page: page}, nil
}

// ListJournalEntries is GET /v1/admin/ledger/entries.
func (a *API) ListJournalEntries(ctx context.Context, req api.ListJournalEntriesRequestObject) (api.ListJournalEntriesResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	rows, page, err := a.svc.JournalEntries(ctx, req.Params)
	if err != nil {
		return nil, err
	}
	return api.ListJournalEntries200JSONResponse{Data: rows, Page: page}, nil
}

// GetJournalEntry is GET /v1/admin/ledger/entries/{entry_id}.
func (a *API) GetJournalEntry(ctx context.Context, req api.GetJournalEntryRequestObject) (api.GetJournalEntryResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	e, err := a.svc.JournalEntry(ctx, req.EntryId)
	if err != nil {
		return nil, err
	}
	return api.GetJournalEntry200JSONResponse(e), nil
}

// GetTrialBalance is GET /v1/admin/ledger/trial-balance.
func (a *API) GetTrialBalance(ctx context.Context, req api.GetTrialBalanceRequestObject) (api.GetTrialBalanceResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	t, err := a.svc.TrialBalance(ctx, req.Params.AsOf)
	if err != nil {
		return nil, err
	}
	return api.GetTrialBalance200JSONResponse(t), nil
}

// RequestLedgerAdjustment is POST /v1/admin/ledger/adjustments.
func (a *API) RequestLedgerAdjustment(ctx context.Context, req api.RequestLedgerAdjustmentRequestObject) (api.RequestLedgerAdjustmentResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	ap, err := a.svc.RequestLedgerAdjustment(ctx, *req.Body)
	if err != nil {
		return nil, err
	}
	return api.RequestLedgerAdjustment202JSONResponse(ap), nil
}

// GetBankConfig is GET /v1/admin/config.
func (a *API) GetBankConfig(ctx context.Context, _ api.GetBankConfigRequestObject) (api.GetBankConfigResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	c, err := a.svc.BankConfig(ctx)
	if err != nil {
		return nil, err
	}
	return api.GetBankConfig200JSONResponse(c), nil
}

// RequestConfigChange is POST /v1/admin/config/changes.
func (a *API) RequestConfigChange(ctx context.Context, req api.RequestConfigChangeRequestObject) (api.RequestConfigChangeResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	ap, err := a.svc.RequestConfigChange(ctx, *req.Body)
	if err != nil {
		return nil, err
	}
	return api.RequestConfigChange202JSONResponse(ap), nil
}

// ListFeatureFlags is GET /v1/admin/feature-flags.
func (a *API) ListFeatureFlags(ctx context.Context, _ api.ListFeatureFlagsRequestObject) (api.ListFeatureFlagsResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	f, err := a.svc.FeatureFlags(ctx)
	if err != nil {
		return nil, err
	}
	return api.ListFeatureFlags200JSONResponse{Data: f}, nil
}

// UpdateFeatureFlag is PUT /v1/admin/feature-flags/{flag_key}.
func (a *API) UpdateFeatureFlag(ctx context.Context, req api.UpdateFeatureFlagRequestObject) (api.UpdateFeatureFlagResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	f, err := a.svc.SetFeatureFlag(ctx, req.FlagKey, req.Body.Enabled, req.Body.Reason)
	if err != nil {
		return nil, err
	}
	return api.UpdateFeatureFlag200JSONResponse(f), nil
}

// ListAuditLog is GET /v1/admin/audit-log.
func (a *API) ListAuditLog(ctx context.Context, req api.ListAuditLogRequestObject) (api.ListAuditLogResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	p, err := a.svc.AuditLog(ctx, req.Params)
	if err != nil {
		return nil, err
	}
	return api.ListAuditLog200JSONResponse(p), nil
}

// VerifyAuditLog is POST /v1/admin/audit-log/verify.
func (a *API) VerifyAuditLog(ctx context.Context, req api.VerifyAuditLogRequestObject) (api.VerifyAuditLogResponseObject, error) {
	if a.off() {
		return nil, api.ErrNotImplemented
	}
	var from, to *int
	if req.Body != nil {
		from, to = req.Body.FromSeq, req.Body.ToSeq
	}
	v, err := a.svc.VerifyAuditLog(ctx, from, to)
	if err != nil {
		return nil, err
	}
	return api.VerifyAuditLog200JSONResponse(v), nil
}
