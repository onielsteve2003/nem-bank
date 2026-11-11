// Package fx is foreign exchange (FR-FX): hourly indicative rates from free providers, the
// bank's spread, 60-second quotes and conversions between a customer's naira account and
// their dollar, pound and euro wallets.
//
// A conversion is one ledger entry. The customer's sold currency goes to the bank's FX
// position account in that currency, and the bank's FX position in the bought currency pays
// the customer. Each currency nets to zero on its own, so the entry balances without any
// exchange rate inside the ledger (architecture §4); the bank's gain from the spread shows
// up as the movement of its positions.
package fx

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts/accountsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/fx/fxdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/limits"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// Pairs are the supported rate pairs: each foreign currency against the naira. The demo
// converts through the naira only, like the mock bank.
var Pairs = []string{"USD-NGN", "GBP-NGN", "EUR-NGN"}

// Tuning. These are policy, not configuration: each has a reason.
const (
	// DefaultSpreadBPS is the bank's margin, 1.5% (FX-5, the mock bank's SPREAD_BPS).
	DefaultSpreadBPS = 150
	// DefaultQuoteTTL is how long a quote holds its rate (FX-1).
	DefaultQuoteTTL = 60 * time.Second
	// staleAfter is when a stored rate is reported as "cache": the hourly job has missed
	// at least one run, so the number is older than the app is told to expect.
	staleAfter = 2 * time.Hour
	// anchorMaxAge is how old the last naira reading may be when it stands in for a
	// provider that has no naira.
	anchorMaxAge = 48 * time.Hour
	// jumpWindow and maxJumpBPS guard against a provider's bad reading: a rate that moved
	// more than 25% since a reading under six hours old is refused, not stored.
	jumpWindow = 6 * time.Hour
	maxJumpBPS = 2_500
	// retainRates is how long readings are kept: the one-year chart plus slack.
	retainRates = 400 * 24 * time.Hour
)

// Problems.
var (
	errNoAnchor = errors.New("fx: provider has no naira rate and there is no recent one to carry")
)

// Accounts is the customer's accounts; *accounts.Service implements it.
type Accounts interface {
	Owned(ctx context.Context, userID, accountID uuid.UUID) (accountsdb.GetCustomerAccountRow, error)
}

// Customers tells fx a customer's KYC tier; identity.Service implements it.
type Customers interface {
	CustomerProfile(ctx context.Context, userID uuid.UUID) (identity.CustomerProfile, error)
}

// RuleSource gives the tier balance caps; *limits.Service implements it.
type RuleSource interface{ Rules() limits.Rules }

// Config holds the service's dependencies.
type Config struct {
	Pool      *pgxpool.Pool
	Accounts  Accounts
	Customers Customers
	Limits    RuleSource
	// Sources are tried in order each hour; the first usable reading is stored.
	Sources []RatesSource
	// SpreadBPS is the margin on every pair unless Spreads names the pair. Zero means
	// DefaultSpreadBPS; staff configuration (ADM-8) will set per-pair values.
	SpreadBPS int
	Spreads   map[string]int
	// QuoteTTL defaults to DefaultQuoteTTL.
	QuoteTTL time.Duration
	Logger   *slog.Logger
	// Now defaults to time.Now.
	Now func() time.Time
}

// Service is the FX domain.
type Service struct {
	pool      *pgxpool.Pool
	q         *fxdb.Queries
	accounts  Accounts
	customers Customers
	limits    RuleSource
	sources   []RatesSource
	spreadBPS int
	spreads   map[string]int
	quoteTTL  time.Duration
	log       *slog.Logger
	now       func() time.Time
}

// NewService builds the service.
func NewService(cfg Config) (*Service, error) {
	if cfg.Pool == nil || cfg.Accounts == nil || cfg.Customers == nil || cfg.Limits == nil || cfg.Logger == nil {
		return nil, errors.New("fx: pool, accounts, customers, limits and logger are required")
	}
	s := &Service{
		pool: cfg.Pool, q: fxdb.New(cfg.Pool), accounts: cfg.Accounts, customers: cfg.Customers, limits: cfg.Limits,
		sources: cfg.Sources, spreadBPS: cfg.SpreadBPS, spreads: cfg.Spreads, quoteTTL: cfg.QuoteTTL,
		log: cfg.Logger.With("component", "fx"), now: cfg.Now,
	}
	if s.spreadBPS == 0 {
		s.spreadBPS = DefaultSpreadBPS
	}
	if s.quoteTTL == 0 {
		s.quoteTTL = DefaultQuoteTTL
	}
	if s.now == nil {
		s.now = time.Now
	}
	for pair, bps := range s.spreads {
		if bps < 0 || bps >= 10_000 {
			return nil, fmt.Errorf("fx: spread for %s must be 0-9999 basis points, got %d", pair, bps)
		}
	}
	if s.spreadBPS < 0 || s.spreadBPS >= 10_000 {
		return nil, fmt.Errorf("fx: spread must be 0-9999 basis points, got %d", s.spreadBPS)
	}
	return s, nil
}

func (s *Service) spread(pair string) int {
	if bps, ok := s.spreads[pair]; ok {
		return bps
	}
	return s.spreadBPS
}

// RateView is a pair's current rates with the spread applied (contract FxRate).
type RateView struct {
	Pair        string
	Base, Quote money.Currency
	Mid         Rate
	// Buy is what the bank pays per unit of Base (the customer sells); Sell is what the
	// bank charges (the customer buys). Buy < Mid < Sell.
	Buy, Sell Rate
	SpreadBPS int
	// Source is the contract's FxRateSource; "cache" when the stored reading is old.
	Source string
	AsOf   time.Time
}

func (s *Service) view(pair string, midE8 int64, source string, asOf time.Time) (RateView, error) {
	mid, bps := Rate(midE8), s.spread(pair)
	buy, err := mid.Discount(bps)
	if err != nil {
		return RateView{}, fmt.Errorf("buy rate for %s: %w", pair, err)
	}
	sell, err := mid.Markup(bps)
	if err != nil {
		return RateView{}, fmt.Errorf("sell rate for %s: %w", pair, err)
	}
	if s.now().Sub(asOf) > staleAfter {
		source = "cache"
	}
	return RateView{
		Pair: pair, Base: money.Currency(pair[:3]), Quote: money.NGN, Mid: mid, Buy: buy, Sell: sell,
		SpreadBPS: bps, Source: source, AsOf: asOf,
	}, nil
}

// Rates lists the latest rate of every pair that has one, in Pairs order.
func (s *Service) Rates(ctx context.Context) ([]RateView, error) {
	rows, err := s.q.LatestRates(ctx)
	if err != nil {
		return nil, fmt.Errorf("latest rates: %w", err)
	}
	byPair := make(map[string]fxdb.LatestRatesRow, len(rows))
	for _, r := range rows {
		byPair[r.Pair] = r
	}
	out := make([]RateView, 0, len(rows))
	for _, pair := range Pairs {
		r, ok := byPair[pair]
		if !ok {
			continue
		}
		v, err := s.view(pair, r.MidE8, r.Source, r.AsOf)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

// Point is one chart point: the last reading in its bucket.
type Point struct {
	At   time.Time
	Rate Rate
}

// ranges are the chart windows and their bucket sizes (the mock bank's RANGES), which keep
// every chart at a few dozen points however much history is stored.
var ranges = map[string]struct{ window, step time.Duration }{
	"1D": {24 * time.Hour, time.Hour},
	"1W": {7 * 24 * time.Hour, 6 * time.Hour},
	"1M": {30 * 24 * time.Hour, 24 * time.Hour},
	"1Y": {365 * 24 * time.Hour, 7 * 24 * time.Hour},
}

// ErrPairNotFound is the 404 for a pair the bank does not quote.
var ErrPairNotFound = problem.NotFound("Rate pair")

// History is the mid-rate chart for a pair over 1D, 1W, 1M or 1Y, oldest first (FX-2).
func (s *Service) History(ctx context.Context, pair, rng string) ([]Point, error) {
	known := false
	for _, p := range Pairs {
		known = known || p == pair
	}
	r, ok := ranges[rng]
	if !known || !ok {
		return nil, ErrPairNotFound
	}
	rows, err := s.q.RateHistory(ctx, fxdb.RateHistoryParams{
		Pair: pair, Since: s.now().Add(-r.window), StepSeconds: int64(r.step / time.Second),
	})
	if err != nil {
		return nil, fmt.Errorf("rate history: %w", err)
	}
	step := int64(r.step / time.Second)
	points := make([]Point, len(rows))
	for i, row := range rows {
		points[i] = Point{At: time.Unix(row.Bucket*step, 0).UTC(), Rate: Rate(row.MidE8)}
	}
	return points, nil
}
