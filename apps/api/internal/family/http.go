package family

import (
	"context"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
)

// API adapts the service to the contract's strict server; the router embeds it. A nil *API
// answers 501.
type API struct{ svc *Service }

// NewAPI returns the family operations for the router.
func NewAPI(svc *Service) *API { return &API{svc: svc} }

// ListDependants is GET /v1/family/dependants.
func (a *API) ListDependants(ctx context.Context, _ api.ListDependantsRequestObject) (api.ListDependantsResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	rows, err := a.svc.Dependants(ctx)
	if err != nil {
		return nil, err
	}
	return api.ListDependants200JSONResponse(api.DependantList{Data: rows}), nil
}

// CreateDependant is POST /v1/family/dependants.
func (a *API) CreateDependant(ctx context.Context, req api.CreateDependantRequestObject) (api.CreateDependantResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	b := req.Body
	out, err := a.svc.CreateDependant(ctx, NewDependant{
		FirstName: b.FirstName, LastName: b.LastName, DateOfBirth: b.DateOfBirth.Time, Nemtag: b.Nemtag, Controls: b.Controls,
	}, req.Params.XStepUpToken)
	if err != nil {
		return nil, err
	}
	return api.CreateDependant201JSONResponse(out), nil
}

// GetDependant is GET /v1/family/dependants/{dependant_id}.
func (a *API) GetDependant(ctx context.Context, req api.GetDependantRequestObject) (api.GetDependantResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	d, err := a.svc.Dependant(ctx, req.DependantId)
	if err != nil {
		return nil, err
	}
	return api.GetDependant200JSONResponse(d), nil
}

// UpdateDependantControls is PATCH /v1/family/dependants/{dependant_id}.
func (a *API) UpdateDependantControls(ctx context.Context, req api.UpdateDependantControlsRequestObject) (api.UpdateDependantControlsResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	d, err := a.svc.UpdateControls(ctx, req.DependantId, *req.Body)
	if err != nil {
		return nil, err
	}
	return api.UpdateDependantControls200JSONResponse(d), nil
}

// SetAllowance is PUT /v1/family/dependants/{dependant_id}/allowance.
func (a *API) SetAllowance(ctx context.Context, req api.SetAllowanceRequestObject) (api.SetAllowanceResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	d, err := a.svc.SetAllowance(ctx, req.DependantId, *req.Body)
	if err != nil {
		return nil, err
	}
	return api.SetAllowance200JSONResponse(d), nil
}

// StopAllowance is DELETE /v1/family/dependants/{dependant_id}/allowance.
func (a *API) StopAllowance(ctx context.Context, req api.StopAllowanceRequestObject) (api.StopAllowanceResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	if err := a.svc.StopAllowance(ctx, req.DependantId); err != nil {
		return nil, err
	}
	return api.StopAllowance204Response{}, nil
}

// ListDependantActivity is GET /v1/family/dependants/{dependant_id}/activity.
func (a *API) ListDependantActivity(ctx context.Context, req api.ListDependantActivityRequestObject) (api.ListDependantActivityResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	rows, page, err := a.svc.Activity(ctx, req.DependantId, req.Params.Cursor, req.Params.Limit)
	if err != nil {
		return nil, err
	}
	return api.ListDependantActivity200JSONResponse(api.TransactionPage{Data: rows, Page: page}), nil
}

// ListFamilyApprovals is GET /v1/family/approvals.
func (a *API) ListFamilyApprovals(ctx context.Context, req api.ListFamilyApprovalsRequestObject) (api.ListFamilyApprovalsResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	var status *string
	if req.Params.Status != nil {
		s := string(*req.Params.Status)
		status = &s
	}
	rows, err := a.svc.Approvals(ctx, status)
	if err != nil {
		return nil, err
	}
	return api.ListFamilyApprovals200JSONResponse(api.FamilyApprovalList{Data: rows}), nil
}

// ApproveFamilyTransfer is POST /v1/family/approvals/{approval_id}/approve.
func (a *API) ApproveFamilyTransfer(ctx context.Context, req api.ApproveFamilyTransferRequestObject) (api.ApproveFamilyTransferResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	out, err := a.svc.Approve(ctx, req.ApprovalId)
	if err != nil {
		return nil, err
	}
	return api.ApproveFamilyTransfer200JSONResponse(out), nil
}

// DeclineFamilyTransfer is POST /v1/family/approvals/{approval_id}/decline.
func (a *API) DeclineFamilyTransfer(ctx context.Context, req api.DeclineFamilyTransferRequestObject) (api.DeclineFamilyTransferResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	out, err := a.svc.Decline(ctx, req.ApprovalId)
	if err != nil {
		return nil, err
	}
	return api.DeclineFamilyTransfer200JSONResponse(out), nil
}
