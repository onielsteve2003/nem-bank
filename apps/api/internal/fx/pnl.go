package fx

import (
	"context"
	"fmt"
	"time"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/fx/fxdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// lagos is the calendar the report's dates are in (UTC+1, no daylight saving).
var lagos = time.FixedZone("WAT", 3600)

const defaultPnlDays = 30

// PnlLine is one foreign currency's trading in the period.
type PnlLine struct {
	Currency money.Currency
	// Conversions counts both directions.
	Conversions int
	// Bought is foreign currency the bank bought from customers who sold it; Sold is what
	// the bank sold to customers who bought it.
	Bought, Sold money.Money
	// Spread is the bank's income in naira against each quote's mid rate.
	Spread money.Money
	// Position is the bank's FX position account balance in this currency now.
	Position money.Money
}

// Pnl is the FX profit-and-loss report (FX-5).
type Pnl struct {
	From, To time.Time // inclusive Lagos dates, as UTC midnights
	Spread   money.Money
	Lines    []PnlLine
}

// Pnl reports spread income per currency for the Lagos dates from..to inclusive. A zero
// time means the default: the last 30 days up to today. Spread is measured against the mid
// rate stored with each quote, so it is the margin customers paid, not a mark-to-market of
// the bank's open position; the position balances show that exposure separately.
func (s *Service) Pnl(ctx context.Context, from, to time.Time) (Pnl, error) {
	today := s.now().In(lagos)
	if to.IsZero() {
		to = time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, time.UTC)
	}
	if from.IsZero() {
		from = to.AddDate(0, 0, -(defaultPnlDays - 1))
	}
	if from.After(to) {
		return Pnl{}, problem.Validation(problem.Field("/from", "after_to", "The start date must not be after the end date."))
	}
	if to.Sub(from) > 366*24*time.Hour {
		return Pnl{}, problem.Validation(problem.Field("/from", "range_too_long", "Pick a period of up to a year."))
	}
	start := time.Date(from.Year(), from.Month(), from.Day(), 0, 0, 0, 0, lagos)
	end := time.Date(to.Year(), to.Month(), to.Day()+1, 0, 0, 0, 0, lagos)
	rows, err := s.q.SpreadByCurrency(ctx, fxdb.SpreadByCurrencyParams{FromAt: start, ToAt: end})
	if err != nil {
		return Pnl{}, fmt.Errorf("spread by currency: %w", err)
	}
	byCur := make(map[string]fxdb.SpreadByCurrencyRow, len(rows))
	for _, r := range rows {
		byCur[r.Currency] = r
	}

	out := Pnl{From: from, To: to, Spread: money.Zero(money.NGN)}
	for _, pair := range Pairs {
		cur := money.Currency(pair[:3])
		r := byCur[string(cur)] // zero when nothing traded: every currency still gets a line
		pos, err := ledger.SystemAccount(ctx, s.pool, ledger.KindFXPosition, string(cur))
		if err != nil {
			return Pnl{}, err
		}
		line := PnlLine{
			Currency: cur, Conversions: int(r.Conversions), Bought: money.New(r.BoughtMinor, cur), Sold: money.New(r.SoldMinor, cur),
			Spread: money.New(r.SpreadMinor, money.NGN), Position: money.New(pos.BalanceMinor, cur),
		}
		if out.Spread, err = out.Spread.Add(line.Spread); err != nil {
			return Pnl{}, fmt.Errorf("total spread: %w", err)
		}
		out.Lines = append(out.Lines, line)
	}
	return out, nil
}

// GetFxPnlReport is GET /v1/admin/fx/pnl.
func (a *API) GetFxPnlReport(ctx context.Context, req api.GetFxPnlReportRequestObject) (api.GetFxPnlReportResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	var from, to time.Time
	if req.Params.From != nil {
		from = req.Params.From.Time
	}
	if req.Params.To != nil {
		to = req.Params.To.Time
	}
	r, err := a.svc.Pnl(ctx, from, to)
	if err != nil {
		return nil, err
	}
	out := api.GetFxPnlReport200JSONResponse{
		PeriodFrom: api.Date{Time: r.From}, PeriodTo: api.Date{Time: r.To}, SpreadIncome: accounts.Money(r.Spread),
		Lines: make([]api.FxPnlLine, len(r.Lines)),
	}
	for i, l := range r.Lines {
		out.Lines[i] = api.FxPnlLine{
			Currency: api.CurrencyCode(l.Currency), Conversions: l.Conversions, BoughtFromCustomers: accounts.Money(l.Bought),
			SoldToCustomers: accounts.Money(l.Sold), SpreadIncome: accounts.Money(l.Spread), Position: accounts.Money(l.Position),
		}
	}
	return out, nil
}
