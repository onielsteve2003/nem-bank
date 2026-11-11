package forecast

import (
	"context"
	"strconv"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

// API adapts the service to the contract's strict server; the router embeds it. A nil *API
// answers 501.
type API struct{ svc *Service }

// NewAPI returns the forecast operations for the router.
func NewAPI(svc *Service) *API { return &API{svc: svc} }

func apiMoney(minor int64, currency string) api.Money {
	return api.Money{AmountMinor: strconv.FormatInt(minor, 10), Currency: api.CurrencyCode(currency)}
}

const modelVersion = "ses-v1"

func meta(usedModel bool, why string) api.AiMeta {
	return api.AiMeta{Feature: api.AiMetaFeatureForecast, ModelVersion: modelVersion, FallbackUsed: !usedModel, Explanation: why}
}

// GetCashFlowForecast is GET /v1/insights/forecast.
func (a *API) GetCashFlowForecast(ctx context.Context, _ api.GetCashFlowForecastRequestObject) (api.GetCashFlowForecastResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	r, err := a.svc.Forecast(ctx)
	if err != nil {
		return nil, err
	}
	ngn := string(money.NGN)
	out := api.CashFlowForecast{
		Points:      make([]api.ForecastPoint, len(r.Points)),
		Explanation: r.Explanation,
		Ai: meta(r.Smoothed, "Projects your daily spending forward with exponential smoothing (recent days count more), "+
			"adds the salary and subscriptions we found, and widens the band the further ahead it looks. "+
			"It is a statistical estimate from your own history, not a promise."),
	}
	for i, p := range r.Points {
		out.Points[i] = api.ForecastPoint{
			Date: openapi_types.Date{Time: p.Date}, Balance: apiMoney(p.Balance, ngn), Low: apiMoney(p.Low, ngn), High: apiMoney(p.High, ngn),
		}
	}
	if n := len(r.Points); n > 0 {
		out.ProjectedBalance = out.Points[n-1].Balance
	}
	if r.NextPayday != nil {
		d := openapi_types.Date{Time: *r.NextPayday}
		out.NextPayday = &d
	}
	out.Upcoming = make([]struct {
		Amount    api.Money     `json:"amount"`
		Date      api.Date      `json:"date"`
		Direction api.Direction `json:"direction"`
		Label     string        `json:"label"`
	}, len(r.Upcoming))
	for i, u := range r.Upcoming {
		dir := api.DirectionDebit
		if u.Credit {
			dir = api.DirectionCredit
		}
		out.Upcoming[i].Amount, out.Upcoming[i].Date = apiMoney(u.Amount, ngn), openapi_types.Date{Time: u.Date}
		out.Upcoming[i].Direction, out.Upcoming[i].Label = dir, u.Label
	}
	return api.GetCashFlowForecast200JSONResponse(out), nil
}

// ListDetectedSubscriptions is GET /v1/insights/subscriptions.
func (a *API) ListDetectedSubscriptions(ctx context.Context, _ api.ListDetectedSubscriptionsRequestObject) (api.ListDetectedSubscriptionsResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	subs, err := a.svc.Subscriptions(ctx)
	if err != nil {
		return nil, err
	}
	var monthly int64
	out := api.SubscriptionList{
		Data: make([]api.DetectedSubscription, len(subs)),
		Ai: meta(true, "Merchants that charged you a similar amount on a weekly, monthly or yearly rhythm "+
			"(three or more times for monthly). Found by checking the gaps between charges, nothing more."),
	}
	for i, s := range subs {
		out.Data[i] = api.DetectedSubscription{
			Id: s.ID, Merchant: s.Merchant, Amount: apiMoney(s.Amount, s.Currency),
			Frequency: api.DetectedSubscriptionFrequency(s.Frequency), LastChargedAt: s.LastAt,
			NextExpectedAt: openapi_types.Date{Time: s.Next}, CardId: s.CardID,
		}
		if s.Currency == string(money.NGN) {
			monthly += s.MonthlyAmount()
		}
	}
	// The total counts naira subscriptions only: adding other currencies needs a rate.
	out.MonthlyTotal = apiMoney(monthly, string(money.NGN))
	return api.ListDetectedSubscriptions200JSONResponse(out), nil
}
