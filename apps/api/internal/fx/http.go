package fx

import (
	"context"
	"fmt"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
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

func quoteJSON(q QuoteView) api.FxQuote {
	return api.FxQuote{
		QuoteId: q.ID, FromAccountId: q.From, ToAccountId: q.To, Sell: accounts.Money(q.Sell), Buy: accounts.Money(q.Buy),
		Rate: q.Rate.String(), MidRate: q.Mid.String(), SpreadBps: q.SpreadBPS, Fee: accounts.Money(q.Fee), ExpiresAt: q.ExpiresAt,
	}
}

// ConversionJSON is the contract's FxConversion.
func ConversionJSON(c ConversionView) api.FxConversion {
	return api.FxConversion{
		Id: c.ID, QuoteId: c.QuoteID, Sell: accounts.Money(c.Sell), Buy: accounts.Money(c.Buy), Rate: c.Rate.String(),
		Fee: accounts.Money(c.Fee), Status: api.FxConversionStatus(c.Status), DebitTransactionId: c.DebitTransaction,
		CreditTransactionId: c.CreditTransaction, CreatedAt: c.CreatedAt,
	}
}

func optionalMoney(m *api.Money) (*money.Money, error) {
	if m == nil {
		return nil, nil //nolint:nilnil // no amount is a valid value
	}
	v, err := money.ParseMinor(m.AmountMinor, string(m.Currency))
	if err != nil {
		return nil, fmt.Errorf("amount passed validation but not parsing: %w", err)
	}
	return &v, nil
}

// CreateFxQuote is POST /v1/fx/quotes.
func (a *API) CreateFxQuote(ctx context.Context, req api.CreateFxQuoteRequestObject) (api.CreateFxQuoteResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	b := req.Body
	sell, err := optionalMoney(b.SellAmount)
	if err != nil {
		return nil, err
	}
	buy, err := optionalMoney(b.BuyAmount)
	if err != nil {
		return nil, err
	}
	q, err := a.svc.Quote(ctx, QuoteRequest{From: b.FromAccountId, To: b.ToAccountId, Sell: sell, Buy: buy})
	if err != nil {
		return nil, err
	}
	return api.CreateFxQuote201JSONResponse(quoteJSON(q)), nil
}

// ConvertCurrency is POST /v1/fx/conversions.
func (a *API) ConvertCurrency(ctx context.Context, req api.ConvertCurrencyRequestObject) (api.ConvertCurrencyResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	c, err := a.svc.Convert(ctx, req.Body.QuoteId)
	if err != nil {
		return nil, err
	}
	return api.ConvertCurrency201JSONResponse(ConversionJSON(c)), nil
}

// ListFxConversions is GET /v1/fx/conversions.
func (a *API) ListFxConversions(ctx context.Context, req api.ListFxConversionsRequestObject) (api.ListFxConversionsResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	rows, page, err := a.svc.Conversions(ctx, req.Params.Cursor, req.Params.Limit)
	if err != nil {
		return nil, err
	}
	out := api.ListFxConversions200JSONResponse{Data: make([]api.FxConversion, len(rows)), Page: page}
	for i, c := range rows {
		out.Data[i] = ConversionJSON(c)
	}
	return out, nil
}
