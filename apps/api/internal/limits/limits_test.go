package limits

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

func ngn(minor int64) money.Money { return money.New(minor, money.NGN) }

func TestFeesAndLevyFollowTheDemoSchedule(t *testing.T) {
	t.Parallel()
	r := DefaultRules()
	for _, tc := range []struct {
		amount int64
		rail   string
		fee    int64
	}{
		{100, "interbank", 1_000},
		{500_000, "interbank", 1_000},
		{500_001, "interbank", 2_500},
		{5_000_000, "interbank", 2_500},
		{5_000_001, "interbank", 5_000},
		{900_000_000, "interbank", 5_000},
		{900_000_000, "internal", 0},
	} {
		if got := r.TransferFee(ngn(tc.amount), tc.rail); got.Amount() != tc.fee {
			t.Errorf("fee(%d, %s) = %d, want %d", tc.amount, tc.rail, got.Amount(), tc.fee)
		}
	}
	for inflow, levy := range map[int64]int64{999_999: 0, 1_000_000: 5_000, 50_000_000: 5_000} {
		if got := r.EMTL(ngn(inflow)); got.Amount() != levy {
			t.Errorf("emtl(%d) = %d, want %d", inflow, got.Amount(), levy)
		}
	}
	if got := r.EMTL(money.New(5_000_000, money.USD)); !got.IsZero() {
		t.Errorf("dollar inflows pay no EMTL: %v", got)
	}
	if r.Tier(9).DailyMinor != r.Tier(1).DailyMinor {
		t.Error("an unknown tier must get the strictest caps")
	}
}

func TestDaysTurnAtLagosMidnight(t *testing.T) {
	t.Parallel()
	for at, want := range map[string]string{
		"2026-11-09T22:59:59Z": "2026-11-09",
		"2026-11-09T23:00:00Z": "2026-11-10",
		"2026-11-09T00:30:00Z": "2026-11-09",
	} {
		ts, _ := time.Parse(time.RFC3339, at)
		if got := Day(ts).Format(time.DateOnly); got != want {
			t.Errorf("Day(%s) = %s, want %s", at, got, want)
		}
	}
}

type fakeCustomers struct{ tier int }

func (c fakeCustomers) CustomerProfile(context.Context, uuid.UUID) (identity.CustomerProfile, error) {
	return identity.CustomerProfile{KycTier: c.tier}, nil
}
func (fakeCustomers) CoolOff(context.Context) (identity.CoolOff, error) {
	return identity.CoolOff{}, nil
}

// fakeStepUps accepts the token "ok" once.
type fakeStepUps struct {
	mu   sync.Mutex
	used bool
}

func (f *fakeStepUps) ConsumeStepUp(_ context.Context, _ pgx.Tx, _ uuid.UUID, purpose, token string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if token != "ok" || purpose != StepUpPurpose || f.used {
		return identity.ErrStepUpRequired
	}
	f.used = true
	return nil
}

func ptr(v int64) *int64 { return &v }

func eq(a, b *int64) bool { return (a == nil && b == nil) || (a != nil && b != nil && *a == *b) }

func TestOwnLimitsTightenAtOnceAndLoosenAfterADay(t *testing.T) {
	t.Parallel()
	pool := testdb.New(t)
	clock := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	steps := &fakeStepUps{}
	svc, err := NewService(Config{Pool: pool, Customers: fakeCustomers{tier: 2}, StepUps: steps, Now: func() time.Time { return clock }})
	if err != nil {
		t.Fatal(err)
	}
	user := uuid.New()
	if _, err := pool.Exec(t.Context(), `INSERT INTO users (id, first_name, last_name, email, phone, date_of_birth,
		password_hash, terms_version, privacy_version, consent_accepted_at)
		VALUES ($1, 'Tolu', 'Test', 'tolu@example.com', '+2348031000001', '1996-04-12', 'x', '2026-10', '2026-10', now())`, user); err != nil {
		t.Fatal(err)
	}
	ctx := identity.WithPrincipal(t.Context(), identity.Principal{UserID: user})
	m := func(minor int64) *money.Money { v := ngn(minor); return &v }

	o, err := svc.Get(ctx)
	if err != nil || o.DailyMinor != nil || o.SingleMinor != nil || o.KYCDailyCapMinor != 20_000_000 || o.Pending != nil {
		t.Fatalf("fresh = %+v, %v", o, err)
	}

	// Setting a first limit only tightens: no step-up, applies now.
	if o, err = svc.Set(ctx, m(5_000_000), m(1_000_000), ""); err != nil || !eq(o.DailyMinor, ptr(5_000_000)) || o.Pending != nil {
		t.Fatalf("tighten = %+v, %v", o, err)
	}

	for name, tc := range map[string]struct {
		daily, single *money.Money
		code          string
	}{
		"above the tier cap":       {m(20_000_001), nil, CodeLimitExceeded},
		"single above daily":       {m(1_000_000), m(2_000_000), problem.CodeValidationFailed},
		"zero":                     {m(0), nil, problem.CodeValidationFailed},
		"dollars":                  {&[]money.Money{money.New(100, money.USD)}[0], nil, problem.CodeValidationFailed},
		"raising without step-up":  {m(6_000_000), m(1_000_000), "step_up_required"},
		"removing without step-up": {nil, m(1_000_000), "step_up_required"},
	} {
		_, err := svc.Set(ctx, tc.daily, tc.single, "")
		var p *problem.Error
		if !errors.As(err, &p) || p.Code != tc.code {
			t.Errorf("%s: %v, want %s", name, err, tc.code)
		}
	}

	// Raising waits a day behind a step-up; the old limits hold meanwhile.
	o, err = svc.Set(ctx, m(8_000_000), nil, "ok")
	if err != nil || !eq(o.DailyMinor, ptr(5_000_000)) || o.Pending == nil || !eq(o.Pending.DailyMinor, ptr(8_000_000)) ||
		o.Pending.SingleMinor != nil || !o.Pending.EffectiveAt.Equal(clock.Add(24*time.Hour)) {
		t.Fatalf("raise = %+v, %v", o, err)
	}
	st, err := svc.StatusFor(t.Context(), pool, user, 2, identity.CoolOff{})
	if err != nil || st.DailyMinor != 5_000_000 || !st.SelfSet {
		t.Fatalf("status while pending = %+v, %v", st, err)
	}

	clock = clock.Add(24 * time.Hour)
	o, err = svc.Get(ctx)
	if err != nil || !eq(o.DailyMinor, ptr(8_000_000)) || o.SingleMinor != nil || o.Pending != nil {
		t.Fatalf("after a day = %+v, %v", o, err)
	}

	// Tightening again cancels nothing it shouldn't and applies at once.
	if o, err = svc.Set(ctx, m(1_000_000), nil, ""); err != nil || !eq(o.DailyMinor, ptr(1_000_000)) {
		t.Fatalf("tighten again = %+v, %v", o, err)
	}
}
