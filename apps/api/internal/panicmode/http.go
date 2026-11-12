package panicmode

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/realtime"
)

// API adapts the service to the contract's strict server; the router embeds it. A nil *API
// answers 501.
type API struct {
	svc *Service
}

// NewAPI returns the panic operations for the router.
func NewAPI(svc *Service) *API { return &API{svc: svc} }

func stateJSON(st State) api.PanicState {
	out := api.PanicState{Active: st.Active, CardsFrozen: st.CardsFrozen, OutgoingBlocked: st.OutgoingBlocked}
	if st.ActivatedAt != nil {
		t := st.ActivatedAt.UTC()
		out.ActivatedAt = &t
	}
	return out
}

// GetPanicState is GET /v1/security/panic.
func (a *API) GetPanicState(ctx context.Context, _ api.GetPanicStateRequestObject) (api.GetPanicStateResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	st, err := a.svc.Get(ctx)
	if err != nil {
		return nil, err
	}
	return api.GetPanicState200JSONResponse(stateJSON(st)), nil
}

// ActivatePanic is POST /v1/security/panic.
func (a *API) ActivatePanic(ctx context.Context, _ api.ActivatePanicRequestObject) (api.ActivatePanicResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	st, err := a.svc.Activate(ctx)
	if err != nil {
		return nil, err
	}
	return api.ActivatePanic200JSONResponse(stateJSON(st)), nil
}

// ReleasePanic is DELETE /v1/security/panic.
func (a *API) ReleasePanic(ctx context.Context, req api.ReleasePanicRequestObject) (api.ReleasePanicResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	st, err := a.svc.Release(ctx, req.Params.XStepUpToken)
	if err != nil {
		return nil, err
	}
	return api.ReleasePanic200JSONResponse(stateJSON(st)), nil
}

// event is the payload written by emit.
type event struct {
	UserID          uuid.UUID  `json:"user_id"`
	Active          bool       `json:"active"`
	ActivatedAt     *time.Time `json:"activated_at"`
	CardsFrozen     int        `json:"cards_frozen"`
	OutgoingBlocked bool       `json:"outgoing_blocked"`
}

// RealtimeSubscriber tells every open app of the customer that panic mode changed
// (security.panic_changed), so a second device shows it at once.
func (s *Service) RealtimeSubscriber(hub *realtime.Hub) jobs.Subscriber {
	return jobs.Subscriber{
		Name:   "realtime_panic",
		Topics: []string{Topic},
		Handle: func(_ context.Context, d jobs.Delivery) error {
			var e event
			if err := json.Unmarshal(d.Payload, &e); err != nil {
				return fmt.Errorf("panic event payload: %w", err)
			}
			data := stateJSON(State{Active: e.Active, ActivatedAt: e.ActivatedAt, CardsFrozen: e.CardsFrozen, OutgoingBlocked: e.OutgoingBlocked})
			return hub.Publish(e.UserID, realtime.Event{
				ID: uuid.NewSHA1(d.ID, []byte(Topic)), Type: Topic, OccurredAt: d.CreatedAt.UTC(), Data: data,
			})
		},
	}
}
