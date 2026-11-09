package limits

import (
	"context"
	"fmt"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

// API adapts the service to the contract's strict server; the router embeds it. A nil
// *API answers 501.
type API struct {
	svc *Service
}

// NewAPI returns the limits operations for the router.
func NewAPI(svc *Service) *API { return &API{svc: svc} }

// StatusJSON is the contract's LimitStatus.
func StatusJSON(st Status) api.LimitStatus {
	ngn := func(minor int64) api.Money { return accounts.Money(money.New(minor, money.NGN)) }
	return api.LimitStatus{
		KycTier: api.KycTier(st.Tier), DailyLimit: ngn(st.DailyMinor), UsedToday: ngn(st.UsedMinor),
		RemainingToday: ngn(st.RemainingMinor), SelfSet: st.SelfSet, CoolOffActive: st.CoolOffActive,
	}
}

func optionalNGN(minor *int64) *api.Money {
	if minor == nil {
		return nil
	}
	m := accounts.Money(money.New(*minor, money.NGN))
	return &m
}

func ownJSON(o Own) api.SelfLimits {
	out := api.SelfLimits{
		DailyLimit: optionalNGN(o.DailyMinor), SingleLimit: optionalNGN(o.SingleMinor),
		KycDailyCap: accounts.Money(money.New(o.KYCDailyCapMinor, money.NGN)),
	}
	if o.Pending != nil {
		out.PendingIncrease = &struct {
			DailyLimit  *api.Money    `json:"daily_limit"`
			EffectiveAt api.Timestamp `json:"effective_at"`
			SingleLimit *api.Money    `json:"single_limit"`
		}{DailyLimit: optionalNGN(o.Pending.DailyMinor), EffectiveAt: o.Pending.EffectiveAt.UTC(), SingleLimit: optionalNGN(o.Pending.SingleMinor)}
	}
	return out
}

func parseOptional(m *api.Money) (*money.Money, error) {
	if m == nil {
		return nil, nil //nolint:nilnil // nil is "no limit", a valid value
	}
	v, err := money.ParseMinor(m.AmountMinor, string(m.Currency))
	if err != nil {
		return nil, fmt.Errorf("limit passed validation but not parsing: %w", err)
	}
	return &v, nil
}

// GetSelfLimits is GET /v1/security/limits.
func (a *API) GetSelfLimits(ctx context.Context, _ api.GetSelfLimitsRequestObject) (api.GetSelfLimitsResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	o, err := a.svc.Get(ctx)
	if err != nil {
		return nil, err
	}
	return api.GetSelfLimits200JSONResponse(ownJSON(o)), nil
}

// SetSelfLimits is PUT /v1/security/limits.
func (a *API) SetSelfLimits(ctx context.Context, req api.SetSelfLimitsRequestObject) (api.SetSelfLimitsResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	daily, err := parseOptional(req.Body.DailyLimit)
	if err != nil {
		return nil, err
	}
	single, err := parseOptional(req.Body.SingleLimit)
	if err != nil {
		return nil, err
	}
	token := ""
	if req.Params.XStepUpToken != nil {
		token = *req.Params.XStepUpToken
	}
	o, err := a.svc.Set(ctx, daily, single, token)
	if err != nil {
		return nil, err
	}
	return api.SetSelfLimits200JSONResponse(ownJSON(o)), nil
}
