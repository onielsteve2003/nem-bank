package admin

import (
	"context"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/admin/admindb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
)

// API adapts the service to the contract's strict server; the router embeds it next to
// the other domains. Role checks (x-roles) run in the request validator before these do.
type API struct {
	svc *Service
}

// NewAPI returns the staff operations for the router.
func NewAPI(svc *Service) *API { return &API{svc: svc} }

func staffJSON(st admindb.Staff) api.Staff {
	roles := make([]api.StaffRole, len(st.Roles))
	for i, r := range st.Roles {
		roles[i] = api.StaffRole(r)
	}
	out := api.Staff{
		Id: st.ID, Name: st.Name, Email: openapi_types.Email(st.Email), Roles: roles,
		TotpEnrolled: st.TotpEnrolledAt != nil,
	}
	if st.LastLoginAt != nil {
		t := st.LastLoginAt.UTC()
		out.LastLoginAt = &t
	}
	return out
}

func refJSON(r StaffRef) api.StaffRef { return api.StaffRef{Id: r.ID, Name: r.Name} }

func approvalJSON(a Approval) api.ApprovalRequest {
	out := api.ApprovalRequest{
		Id: a.ID, Action: api.ApprovalRequestAction(a.Action), Status: api.MakerCheckerStatus(a.Status),
		Maker: refJSON(a.Maker), Reason: a.Reason, Summary: a.Summary, RejectionReason: a.RejectionReason,
		CreatedAt: a.CreatedAt.UTC(), ExpiresAt: a.ExpiresAt.UTC(),
	}
	if a.Before != nil {
		out.Before = &a.Before
	}
	if a.After != nil {
		out.After = &a.After
	}
	if a.Checker != nil {
		c := refJSON(*a.Checker)
		out.Checker = &c
	}
	if a.DecidedAt != nil {
		t := a.DecidedAt.UTC()
		out.DecidedAt = &t
	}
	return out
}

// StaffLogin is POST /v1/admin/auth/login.
func (a *API) StaffLogin(ctx context.Context, req api.StaffLoginRequestObject) (api.StaffLoginResponseObject, error) {
	var password string
	if req.Body.Password != nil {
		password = *req.Body.Password
	}
	ch, err := a.svc.Login(ctx, string(req.Body.Email), password)
	if err != nil {
		return nil, err
	}
	out := api.StaffLogin200JSONResponse{ChallengeId: ch.ID, ExpiresAt: ch.ExpiresAt.UTC()}
	if ch.EnrolmentURI != nil {
		out.TotpEnrolment = &struct {
			OtpauthUri string `json:"otpauth_uri"` //nolint:revive // must match the generated anonymous struct exactly
		}{OtpauthUri: *ch.EnrolmentURI}
	}
	return out, nil
}

// StaffVerifyTotp is POST /v1/admin/auth/totp.
func (a *API) StaffVerifyTotp(ctx context.Context, req api.StaffVerifyTotpRequestObject) (api.StaffVerifyTotpResponseObject, error) {
	sess, err := a.svc.VerifyTOTP(ctx, req.Body.ChallengeId, req.Body.Code)
	if err != nil {
		return nil, err
	}
	return api.StaffVerifyTotp200JSONResponse{
		AccessToken: sess.AccessToken, ExpiresAt: sess.ExpiresAt.UTC(), Staff: staffJSON(sess.Staff),
	}, nil
}

// StaffLogout is POST /v1/admin/auth/logout.
func (a *API) StaffLogout(ctx context.Context, _ api.StaffLogoutRequestObject) (api.StaffLogoutResponseObject, error) {
	if err := a.svc.Logout(ctx); err != nil {
		return nil, err
	}
	return api.StaffLogout204Response{}, nil
}

// GetStaffMe is GET /v1/admin/me.
func (a *API) GetStaffMe(ctx context.Context, _ api.GetStaffMeRequestObject) (api.GetStaffMeResponseObject, error) {
	st, err := a.svc.Me(ctx)
	if err != nil {
		return nil, err
	}
	return api.GetStaffMe200JSONResponse(staffJSON(st)), nil
}

// ListApprovalRequests is GET /v1/admin/approvals.
func (a *API) ListApprovalRequests(ctx context.Context, req api.ListApprovalRequestsRequestObject) (api.ListApprovalRequestsResponseObject, error) {
	status := StatusPending
	if req.Params.Status != nil {
		status = string(*req.Params.Status)
	}
	rows, page, err := a.svc.List(ctx, status, req.Params.Cursor, req.Params.Limit)
	if err != nil {
		return nil, err
	}
	data := make([]api.ApprovalRequest, len(rows))
	for i, r := range rows {
		data[i] = approvalJSON(r)
	}
	return api.ListApprovalRequests200JSONResponse{Data: data, Page: page}, nil
}

// GetApprovalRequest is GET /v1/admin/approvals/{approval_id}.
func (a *API) GetApprovalRequest(ctx context.Context, req api.GetApprovalRequestRequestObject) (api.GetApprovalRequestResponseObject, error) {
	r, err := a.svc.Get(ctx, req.ApprovalId)
	if err != nil {
		return nil, err
	}
	return api.GetApprovalRequest200JSONResponse(approvalJSON(r)), nil
}

// ApproveRequest is POST /v1/admin/approvals/{approval_id}/approve.
func (a *API) ApproveRequest(ctx context.Context, req api.ApproveRequestRequestObject) (api.ApproveRequestResponseObject, error) {
	r, err := a.svc.Approve(ctx, req.ApprovalId)
	if err != nil {
		return nil, err
	}
	return api.ApproveRequest200JSONResponse(approvalJSON(r)), nil
}

// RejectRequest is POST /v1/admin/approvals/{approval_id}/reject.
func (a *API) RejectRequest(ctx context.Context, req api.RejectRequestRequestObject) (api.RejectRequestResponseObject, error) {
	r, err := a.svc.Reject(ctx, req.ApprovalId, req.Body.Reason)
	if err != nil {
		return nil, err
	}
	return api.RejectRequest200JSONResponse(approvalJSON(r)), nil
}
