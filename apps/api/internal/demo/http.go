package demo

import (
	"context"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// API adapts the service to the contract's strict server; the router embeds it. A nil *API
// answers 501.
type API struct {
	svc *Service
}

// NewAPI returns the demo operations for the router.
func NewAPI(svc *Service) *API { return &API{svc: svc} }

// StartDemoSession is POST /v1/auth/demo (AUTH-11).
func (a *API) StartDemoSession(ctx context.Context, req api.StartDemoSessionRequestObject) (api.StartDemoSessionResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	persona := "tolu"
	if req.Body != nil && req.Body.Persona != nil {
		persona = string(*req.Body.Persona)
	}
	if req.Body == nil || req.Body.Device == nil {
		return nil, identity.ErrDeviceRequired
	}
	r, err := a.svc.Start(ctx, persona, identity.Registration(*req.Body.Device))
	if err != nil {
		return nil, err
	}
	return api.StartDemoSession201JSONResponse(identity.SessionJSON(r, a.svc.now())), nil
}

// DemoFundWallet is POST /v1/demo/fund.
func (a *API) DemoFundWallet(ctx context.Context, req api.DemoFundWalletRequestObject) (api.DemoFundWalletResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	amount, err := money.ParseMinor(req.Body.Amount.AmountMinor, string(req.Body.Amount.Currency))
	if err != nil {
		return nil, problem.Validation(problem.Field("/amount", "invalid", "Enter a valid amount."))
	}
	t, err := a.svc.Fund(ctx, req.Body.AccountId, amount)
	if err != nil {
		return nil, err
	}
	j, err := accounts.TransactionJSON(t)
	if err != nil {
		return nil, err
	}
	return api.DemoFundWallet201JSONResponse(j), nil
}

// DemoFailNextTransfer is POST /v1/demo/fail-next-transfer.
func (a *API) DemoFailNextTransfer(ctx context.Context, _ api.DemoFailNextTransferRequestObject) (api.DemoFailNextTransferResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	if err := a.svc.FailNextTransfer(ctx); err != nil {
		return nil, err
	}
	return api.DemoFailNextTransfer204Response{}, nil
}

// DemoSetKycTier is POST /v1/demo/kyc-tier.
func (a *API) DemoSetKycTier(ctx context.Context, req api.DemoSetKycTierRequestObject) (api.DemoSetKycTierResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	if err := a.svc.SetKycTier(ctx, int16(req.Body.Tier)); err != nil { //nolint:gosec // the contract's enum is 1 to 3
		return nil, err
	}
	return api.DemoSetKycTier204Response{}, nil
}

// DemoSetKycReview is POST /v1/demo/kyc-review.
func (a *API) DemoSetKycReview(ctx context.Context, req api.DemoSetKycReviewRequestObject) (api.DemoSetKycReviewResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	if err := a.svc.SetKycReview(ctx, string(req.Body.Outcome)); err != nil {
		return nil, err
	}
	return api.DemoSetKycReview204Response{}, nil
}

// DemoTimeTravel is POST /v1/demo/time-travel.
func (a *API) DemoTimeTravel(ctx context.Context, req api.DemoTimeTravelRequestObject) (api.DemoTimeTravelResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	c, err := a.svc.TimeTravel(ctx, req.Body.Days)
	if err != nil {
		return nil, err
	}
	return api.DemoTimeTravel200JSONResponse(api.DemoClock{Now: c.Now, OffsetDays: c.OffsetDays}), nil
}
