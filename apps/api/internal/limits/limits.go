package limits

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/limits/limitsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// CodeLimitExceeded is the contract's limit_exceeded problem code.
const CodeLimitExceeded = "limit_exceeded"

// StepUpPurpose is the step-up a customer completes before raising their own limits.
const StepUpPurpose = "limit_increase"

var (
	errAboveCap = problem.New(http.StatusUnprocessableEntity, CodeLimitExceeded, "Your limits must stay below your KYC cap")
	errSingle   = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "The single limit cannot be above the daily limit")
	errNotNaira = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "Limits are set in naira")
)

// Customers is what limits needs from identity.
type Customers interface {
	CustomerProfile(ctx context.Context, userID uuid.UUID) (identity.CustomerProfile, error)
	CoolOff(ctx context.Context) (identity.CoolOff, error)
}

// StepUps spends the step-up token that raising a limit needs.
type StepUps interface {
	ConsumeStepUp(ctx context.Context, tx pgx.Tx, userID uuid.UUID, purpose, token string) error
}

// Config holds the service's dependencies.
type Config struct {
	Pool      *pgxpool.Pool
	Customers Customers
	// StepUps nil refuses every increase (a service built only to count transfers).
	StepUps StepUps
	// Rules nil means DefaultRules.
	Rules *Rules
	// Now defaults to time.Now.
	Now func() time.Time
}

// Service is the limits engine.
type Service struct {
	pool      *pgxpool.Pool
	customers Customers
	stepUps   StepUps
	rules     Rules
	now       func() time.Time
}

// NewService checks the configuration and returns the service.
func NewService(cfg Config) (*Service, error) {
	if cfg.Pool == nil || cfg.Customers == nil {
		return nil, errors.New("limits: pool and customers are required")
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	rules := DefaultRules()
	if cfg.Rules != nil {
		rules = *cfg.Rules
	}
	return &Service{pool: cfg.Pool, customers: cfg.Customers, stepUps: cfg.StepUps, rules: rules, now: cfg.Now}, nil
}

// Rules are the numbers the engine applies.
func (s *Service) Rules() Rules { return s.rules }

// Status is where a customer stands against today's limits (contract LimitStatus).
type Status struct {
	Tier int
	// Day is the Lagos day the usage is for.
	Day time.Time
	// DailyMinor is the binding daily limit: the lowest of the tier cap, the self-set
	// limit and the cool-off cap.
	DailyMinor, UsedMinor, RemainingMinor int64
	// SingleMinor is the self-set per-transfer limit, if any.
	SingleMinor *int64
	// SelfSet is true when the customer's own limit is the binding one.
	SelfSet, CoolOffActive bool
}

// own loads the customer's self-set limits, first applying an increase whose wait is
// over. A customer who never set any has none.
func (s *Service) own(ctx context.Context, db limitsdb.DBTX, userID uuid.UUID) (limitsdb.SelfLimit, error) {
	q := limitsdb.New(db)
	l, err := q.ApplyDueIncrease(ctx, limitsdb.ApplyDueIncreaseParams{UserID: userID, Now: s.now()})
	if err == nil {
		return l, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return l, fmt.Errorf("apply limit increase: %w", err)
	}
	l, err = q.GetSelfLimits(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return limitsdb.SelfLimit{UserID: userID}, nil
	}
	if err != nil {
		return l, fmt.Errorf("load self limits: %w", err)
	}
	return l, nil
}

// StatusFor is the customer's status today, with their tier and the calling device's
// cool-off, read on db (the caller's transaction or the pool).
func (s *Service) StatusFor(ctx context.Context, db limitsdb.DBTX, userID uuid.UUID, tier int, c identity.CoolOff) (Status, error) {
	own, err := s.own(ctx, db, userID)
	if err != nil {
		return Status{}, err
	}
	st := Status{Tier: tier, Day: Day(s.now()), DailyMinor: s.rules.Tier(tier).DailyMinor, SingleMinor: own.SingleMinor, CoolOffActive: c.Active}
	if own.DailyMinor != nil && *own.DailyMinor < st.DailyMinor {
		st.DailyMinor, st.SelfSet = *own.DailyMinor, true
	}
	if c.Active && c.DailyLimitMinor < st.DailyMinor {
		st.DailyMinor, st.SelfSet = c.DailyLimitMinor, false
	}
	if st.UsedMinor, err = limitsdb.New(db).GetDailyUsage(ctx, limitsdb.GetDailyUsageParams{UserID: userID, Day: st.Day}); err != nil {
		return Status{}, fmt.Errorf("load daily usage: %w", err)
	}
	st.RemainingMinor = max(st.DailyMinor-st.UsedMinor, 0)
	return st, nil
}

// Consume counts amount against today's limits inside the caller's transaction and
// returns the day it was counted on, which Release needs. It refuses an amount above the
// single limit or the rest of the day's limit; the check and the count are one statement,
// so racing transfers cannot both take the last of the day.
func (s *Service) Consume(ctx context.Context, tx pgx.Tx, userID uuid.UUID, tier int, c identity.CoolOff, amount money.Money) (time.Time, error) {
	st, err := s.StatusFor(ctx, tx, userID, tier, c)
	if err != nil {
		return time.Time{}, err
	}
	if st.SingleMinor != nil && amount.Amount() > *st.SingleMinor {
		return time.Time{}, problem.New(http.StatusUnprocessableEntity, CodeLimitExceeded, "Above your single-transfer limit").
			WithDetailf("Your own limit is ₦%s per transfer.", accounts.FormatAmount(*st.SingleMinor))
	}
	_, err = limitsdb.New(tx).ConsumeDailyLimit(ctx, limitsdb.ConsumeDailyLimitParams{
		UserID: userID, Day: st.Day, AmountMinor: amount.Amount(), LimitMinor: st.DailyMinor,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		// Re-read: a transfer that won the race may have used more than st saw.
		used, uerr := limitsdb.New(tx).GetDailyUsage(ctx, limitsdb.GetDailyUsageParams{UserID: userID, Day: st.Day})
		if uerr != nil {
			return time.Time{}, fmt.Errorf("load daily usage: %w", uerr)
		}
		return time.Time{}, problem.New(http.StatusUnprocessableEntity, CodeLimitExceeded, "Daily limit reached").
			WithDetailf("You can send ₦%s more today.", accounts.FormatAmount(max(st.DailyMinor-used, 0)))
	}
	if err != nil {
		return time.Time{}, fmt.Errorf("count against daily limit: %w", err)
	}
	return st.Day, nil
}

// Release gives a failed or reversed transfer's amount back to the day it was counted on.
func (s *Service) Release(ctx context.Context, tx pgx.Tx, userID uuid.UUID, day time.Time, amount money.Money) error {
	if err := limitsdb.New(tx).ReleaseDailyLimit(ctx, limitsdb.ReleaseDailyLimitParams{
		UserID: userID, Day: day, AmountMinor: amount.Amount(),
	}); err != nil {
		return fmt.Errorf("release daily limit: %w", err)
	}
	return nil
}

// Own is a customer's self-set limits (contract SelfLimits).
type Own struct {
	DailyMinor, SingleMinor *int64
	KYCDailyCapMinor        int64
	Pending                 *Pending
}

// Pending is an increase waiting out its delay.
type Pending struct {
	DailyMinor, SingleMinor *int64
	EffectiveAt             time.Time
}

func (s *Service) ownView(l limitsdb.SelfLimit, tier int) Own {
	o := Own{DailyMinor: l.DailyMinor, SingleMinor: l.SingleMinor, KYCDailyCapMinor: s.rules.Tier(tier).DailyMinor}
	if l.PendingEffectiveAt != nil {
		o.Pending = &Pending{DailyMinor: l.PendingDailyMinor, SingleMinor: l.PendingSingleMinor, EffectiveAt: *l.PendingEffectiveAt}
	}
	return o
}

// Get returns the caller's own limits.
func (s *Service) Get(ctx context.Context) (Own, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return Own{}, problem.Unauthorized()
	}
	prof, err := s.customers.CustomerProfile(ctx, p.UserID)
	if err != nil {
		return Own{}, err
	}
	l, err := s.own(ctx, s.pool, p.UserID)
	if err != nil {
		return Own{}, err
	}
	return s.ownView(l, prof.KycTier), nil
}

// Set changes the caller's own limits (nil removes one). Tightening applies at once and
// cancels a waiting increase. Raising or removing a limit loosens protection, so it needs
// a step-up and waits Rules.IncreaseDelay: someone who gets into the app cannot raise and
// spend at once.
func (s *Service) Set(ctx context.Context, daily, single *money.Money, stepUpToken string) (Own, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return Own{}, problem.Unauthorized()
	}
	prof, err := s.customers.CustomerProfile(ctx, p.UserID)
	if err != nil {
		return Own{}, err
	}
	nextDaily, err := ownLimit(daily, "/daily_limit")
	if err != nil {
		return Own{}, err
	}
	nextSingle, err := ownLimit(single, "/single_limit")
	if err != nil {
		return Own{}, err
	}
	capMinor := s.rules.Tier(prof.KycTier).DailyMinor
	if (nextDaily != nil && *nextDaily > capMinor) || (nextSingle != nil && *nextSingle > capMinor) {
		return Own{}, errAboveCap.WithDetailf("Your tier allows up to ₦%s a day.", accounts.FormatAmount(capMinor))
	}
	if nextDaily != nil && nextSingle != nil && *nextSingle > *nextDaily {
		return Own{}, errSingle
	}

	var out limitsdb.SelfLimit
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		cur, err := s.own(ctx, tx, p.UserID)
		if err != nil {
			return err
		}
		q := limitsdb.New(tx)
		if !raises(nextDaily, cur.DailyMinor) && !raises(nextSingle, cur.SingleMinor) {
			out, err = q.SetSelfLimits(ctx, limitsdb.SetSelfLimitsParams{UserID: p.UserID, DailyMinor: nextDaily, SingleMinor: nextSingle})
			return err
		}
		if s.stepUps == nil {
			return identity.ErrStepUpRequired
		}
		if err := s.stepUps.ConsumeStepUp(ctx, tx, p.UserID, StepUpPurpose, stepUpToken); err != nil {
			return err
		}
		out, err = q.SetPendingIncrease(ctx, limitsdb.SetPendingIncreaseParams{
			UserID: p.UserID, PendingDailyMinor: nextDaily, PendingSingleMinor: nextSingle,
			EffectiveAt: s.now().Add(s.rules.IncreaseDelay),
		})
		return err
	})
	if err != nil {
		return Own{}, err
	}
	return s.ownView(out, prof.KycTier), nil
}

// raises reports whether next loosens cur: a higher limit, or none where there was one.
func raises(next, cur *int64) bool {
	return cur != nil && (next == nil || *next > *cur)
}

func ownLimit(m *money.Money, field string) (*int64, error) {
	if m == nil {
		return nil, nil //nolint:nilnil // nil is "no limit", a valid value
	}
	if m.Currency() != money.NGN {
		return nil, errNotNaira
	}
	if !m.IsPositive() {
		return nil, problem.Validation(problem.Field(field, "positive", "Enter an amount above zero, or remove the limit."))
	}
	v := m.Amount()
	return &v, nil
}
