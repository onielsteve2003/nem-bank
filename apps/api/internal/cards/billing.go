package cards

import (
	"context"
	"fmt"
	"net/http"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/fx"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

var errRates = problem.New(http.StatusServiceUnavailable, "rates_unavailable", "Exchange rates are unavailable right now").
	WithDetail("Try again in a few minutes.")

// Rater gives the bank's current rates; *fx.Service implements it.
type Rater interface {
	Rates(ctx context.Context) ([]fx.RateView, error)
}

// billing is what the card's account pays for a charge in the merchant's currency.
//
// The bank sits between the two currencies, always on its own side of the spread and
// rounding up: a charge in a currency the customer would be buying (a dollar charge on a
// naira card) is priced at the bank's sell rate, and a charge in naira on a dollar card is
// priced by selling dollars, at the bank's buy rate. Two foreign currencies go through the
// naira, like conversions do (FX-1).
func billing(amount money.Money, card money.Currency, views []fx.RateView) (money.Money, error) {
	if amount.Currency() == card {
		return amount, nil
	}
	byBase := make(map[money.Currency]fx.RateView, len(views))
	for _, v := range views {
		byBase[v.Base] = v
	}
	naira := amount.Amount()
	if amount.Currency() != money.NGN {
		v, ok := byBase[amount.Currency()]
		if !ok {
			return money.Money{}, errRates
		}
		n, err := v.Sell.Apply(amount.Amount(), money.Ceil)
		if err != nil {
			return money.Money{}, fmt.Errorf("price %s charge in naira: %w", amount.Currency(), err)
		}
		naira = n
	}
	if card == money.NGN {
		return money.New(naira, money.NGN), nil
	}
	v, ok := byBase[card]
	if !ok {
		return money.Money{}, errRates
	}
	out, err := v.Buy.Divide(naira, money.Ceil)
	if err != nil {
		return money.Money{}, fmt.Errorf("price naira charge in %s: %w", card, err)
	}
	return money.New(out, card), nil
}
