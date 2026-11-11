package forecast

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/forecast/forecastdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// How far back each question looks. A year and a bit catches a yearly subscription twice;
// 90 days of spending is about three pay cycles; salary needs two months to show a day.
const (
	subscriptionLookback = 400 * 24 * time.Hour
	spendingDays         = 90
	salaryLookback       = 150 * 24 * time.Hour
)

// Querier is the slice of the generated queries the service uses.
type Querier interface {
	UserCreatedAt(ctx context.Context, id uuid.UUID) (time.Time, error)
	RecurringCandidates(ctx context.Context, arg forecastdb.RecurringCandidatesParams) ([]forecastdb.RecurringCandidatesRow, error)
	SpendingSince(ctx context.Context, arg forecastdb.SpendingSinceParams) ([]forecastdb.SpendingSinceRow, error)
	SalaryCredits(ctx context.Context, arg forecastdb.SalaryCreditsParams) ([]forecastdb.SalaryCreditsRow, error)
}

// Accounts lists the caller's accounts; *accounts.Service implements it.
type Accounts interface {
	List(ctx context.Context) ([]accounts.View, error)
}

// Customers gives the duress flag; *identity.Service implements it.
type Customers interface {
	CustomerProfile(ctx context.Context, userID uuid.UUID) (identity.CustomerProfile, error)
}

var (
	_ Accounts  = (*accounts.Service)(nil)
	_ Customers = (*identity.Service)(nil)
)

// Config holds the service's dependencies.
type Config struct {
	Queries   Querier
	Accounts  Accounts
	Customers Customers
	// SmoothingEnabled is the customer's "AI forecast" setting; nil means on. Off, the
	// plain average is used and the answer says it is the fallback.
	SmoothingEnabled func(ctx context.Context) bool
	// Now defaults to time.Now.
	Now func() time.Time
}

// Service answers the forecast and subscription questions from the transaction history.
type Service struct {
	q        Querier
	accounts Accounts
	cust     Customers
	smooth   func(context.Context) bool
	now      func() time.Time
}

// NewService builds the service.
func NewService(cfg Config) (*Service, error) {
	if cfg.Queries == nil || cfg.Accounts == nil || cfg.Customers == nil {
		return nil, errors.New("forecast: queries, accounts and customers are required")
	}
	s := &Service{q: cfg.Queries, accounts: cfg.Accounts, cust: cfg.Customers, smooth: cfg.SmoothingEnabled, now: cfg.Now}
	if s.now == nil {
		s.now = time.Now
	}
	return s, nil
}

func caller(ctx context.Context) (identity.Principal, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return identity.Principal{}, problem.Unauthorized()
	}
	return p, nil
}

// Subscriptions are the recurring charges found in the caller's history, next charge first.
func (s *Service) Subscriptions(ctx context.Context) ([]Subscription, error) {
	p, err := caller(ctx)
	if err != nil {
		return nil, err
	}
	return s.subscriptions(ctx, p.UserID, Day(s.now()))
}

func (s *Service) subscriptions(ctx context.Context, userID uuid.UUID, today time.Time) ([]Subscription, error) {
	profile, err := s.cust.CustomerProfile(ctx, userID)
	if err != nil {
		return nil, err
	}
	if profile.InDuress {
		return nil, nil // the decoy view has no history to find a pattern in
	}
	rows, err := s.q.RecurringCandidates(ctx, forecastdb.RecurringCandidatesParams{UserID: userID, Since: s.now().Add(-subscriptionLookback)})
	if err != nil {
		return nil, fmt.Errorf("load recurring candidates: %w", err)
	}
	charges := make([]Charge, len(rows))
	for i, r := range rows {
		charges[i] = Charge{ID: r.ID, Merchant: r.Merchant, Currency: r.Currency, Amount: r.AmountMinor, At: r.CreatedAt, CardID: r.CardID}
	}
	return Detect(userID, charges, today), nil
}

// Forecast projects the caller's naira balance.
func (s *Service) Forecast(ctx context.Context) (Result, error) {
	p, err := caller(ctx)
	if err != nil {
		return Result{}, err
	}
	now := s.now()
	today := Day(now)
	profile, err := s.cust.CustomerProfile(ctx, p.UserID)
	if err != nil {
		return Result{}, err
	}
	in := Input{Today: today, Smooth: s.smooth == nil || s.smooth(ctx)}
	views, err := s.accounts.List(ctx)
	if err != nil {
		return Result{}, err
	}
	for _, v := range views {
		if v.Currency == "NGN" {
			in.Balance = v.Available.Amount()
		}
	}
	if profile.InDuress {
		return Project(in), nil
	}
	if in.Subs, err = s.subscriptions(ctx, p.UserID, today); err != nil {
		return Result{}, err
	}
	rows, err := s.q.SpendingSince(ctx, forecastdb.SpendingSinceParams{UserID: p.UserID, Since: today.AddDate(0, 0, -spendingDays)})
	if err != nil {
		return Result{}, fmt.Errorf("load spending: %w", err)
	}
	created, err := s.q.UserCreatedAt(ctx, p.UserID)
	if err != nil {
		return Result{}, fmt.Errorf("load customer: %w", err)
	}
	counted := map[uuid.UUID]bool{}
	for _, sub := range in.Subs {
		for _, id := range sub.Charges {
			counted[id] = true
		}
	}
	// A new customer's history starts at sign-up: the days before it were not "zero spend".
	span := min(spendingDays, max(0, daysBetween(Day(created), today)))
	in.Daily = make([]int64, span)
	for _, r := range rows {
		if counted[r.ID] {
			continue
		}
		if ago := daysBetween(Day(r.CreatedAt), today); ago >= 1 && ago <= span {
			in.Daily[span-ago] += r.AmountMinor
		}
	}
	credits, err := s.q.SalaryCredits(ctx, forecastdb.SalaryCreditsParams{UserID: p.UserID, Since: now.Add(-salaryLookback)})
	if err != nil {
		return Result{}, fmt.Errorf("load salary: %w", err)
	}
	for _, c := range credits {
		in.Salary = append(in.Salary, Credit{Amount: c.AmountMinor, At: c.CreatedAt})
	}
	return Project(in), nil
}
