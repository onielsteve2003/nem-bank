package demo

import (
	"context"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
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
