package fx

import (
	"context"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
)

// API adapts the service to the contract's strict server; the router embeds it. A nil *API
// answers 501.
type API struct {
	svc *Service
}

// NewAPI returns the FX operations for the router.
func NewAPI(svc *Service) *API { return &API{svc: svc} }

// RateJSON is the contract's FxRate.
func RateJSON(v RateView) api.FxRate {
	return api.FxRate{
		Pair: v.Pair, Base: api.CurrencyCode(v.Base), Quote: api.CurrencyCode(v.Quote),
		MidRate: v.Mid.String(), BuyRate: v.Buy.String(), SellRate: v.Sell.String(),
		SpreadBps: v.SpreadBPS, Source: api.FxRateSource(v.Source), AsOf: v.AsOf.UTC(),
	}
}

// ListFxRates is GET /v1/fx/rates.
func (a *API) ListFxRates(ctx context.Context, _ api.ListFxRatesRequestObject) (api.ListFxRatesResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	views, err := a.svc.Rates(ctx)
	if err != nil {
		return nil, err
	}
	out := api.ListFxRates200JSONResponse{Data: make([]api.FxRate, len(views)), Indicative: true}
	for i, v := range views {
		out.Data[i] = RateJSON(v)
	}
	return out, nil
}

// GetFxRateHistory is GET /v1/fx/rates/{pair}/history.
func (a *API) GetFxRateHistory(ctx context.Context, req api.GetFxRateHistoryRequestObject) (api.GetFxRateHistoryResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	points, err := a.svc.History(ctx, req.Pair, string(req.Params.Range))
	if err != nil {
		return nil, err
	}
	out := api.GetFxRateHistory200JSONResponse{
		Pair: req.Pair, Range: api.FxRateHistoryRange(req.Params.Range), Points: make([]api.FxRatePoint, len(points)),
	}
	for i, p := range points {
		out.Points[i] = api.FxRatePoint{At: p.At, Rate: p.Rate.String()}
	}
	return out, nil
}
