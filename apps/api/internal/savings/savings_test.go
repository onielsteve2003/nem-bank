package savings

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

type profiles struct{}

func (profiles) CustomerProfile(context.Context, uuid.UUID) (identity.CustomerProfile, error) {
	return identity.CustomerProfile{Name: "Tolu Adeyemi", KycTier: 2}, nil
}
func (profiles) CoolOff(context.Context) (identity.CoolOff, error) { return identity.CoolOff{}, nil }

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

type fixture struct {
	t    *testing.T
	pool *pgxpool.Pool
	svc  *Service
	clk  *clock
	n    atomic.Int64
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	pool := testdb.New(t)
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	// 10:00 Lagos on a Wednesday.
	f := &fixture{t: t, pool: pool, clk: &clock{t: time.Date(2026, 11, 11, 9, 0, 0, 0, time.UTC)}}
	accts, err := accounts.NewService(accounts.Config{Pool: pool, Customers: profiles{}, Logger: quiet})
	if err != nil {
		t.Fatal(err)
	}
	if f.svc, err = NewService(Config{Pool: pool, Accounts: accts, Logger: quiet, Now: f.clk.Now}); err != nil {
		t.Fatal(err)
	}
	return f
}

type customer struct {
	ctx context.Context
	id  uuid.UUID
	ngn uuid.UUID
}

func (f *fixture) customer(ngnKobo int64) customer {
	f.t.Helper()
	ctx := f.t.Context()
	id := uuid.New()
	n := f.n.Add(1)
	if _, err := f.pool.Exec(ctx, `INSERT INTO users (id, first_name, last_name, email, phone, date_of_birth,
		password_hash, terms_version, privacy_version, consent_accepted_at)
		VALUES ($1, 'Tolu', 'Adeyemi', $2, $3, '1996-04-12', 'x', '2026-10', '2026-10', now())`,
		id, fmt.Sprintf("sav%d@example.com", n), fmt.Sprintf("+2348055%06d", n)); err != nil {
		f.t.Fatal(err)
	}
	if err := pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		return accounts.OpenCurrentAccount(ctx, tx, identity.NewCustomer{UserID: id, Name: "Tolu Adeyemi"})
	}); err != nil {
		f.t.Fatal(err)
	}
	c := customer{ctx: identity.WithPrincipal(ctx, identity.Principal{UserID: id}), id: id}
	if err := f.pool.QueryRow(ctx, `SELECT account_id FROM customer_accounts WHERE user_id = $1 AND currency = 'NGN'`, id).Scan(&c.ngn); err != nil {
		f.t.Fatal(err)
	}
	if ngnKobo > 0 {
		f.fund(c.ngn, ngnKobo)
	}
	return c
}

func (f *fixture) fund(account uuid.UUID, kobo int64) {
	f.t.Helper()
	ctx := f.t.Context()
	if err := pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		src, err := ledger.SystemAccount(ctx, tx, ledger.KindDemoFunding, "NGN")
		if err != nil {
			return err
		}
		amt := money.New(kobo, money.NGN)
		_, err = ledger.Post(ctx, tx, ledger.Entry{Kind: "demo_funding", Reference: "seed",
			Legs: []ledger.Leg{ledger.Debit(src.ID, amt), ledger.Credit(account, amt)}})
		return err
	}); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) balance(account uuid.UUID) int64 {
	f.t.Helper()
	var bal int64
	if err := f.pool.QueryRow(f.t.Context(), `SELECT balance_minor FROM ledger_accounts WHERE id = $1`, account).Scan(&bal); err != nil {
		f.t.Fatal(err)
	}
	return bal
}

func (f *fixture) goalAccount(goal uuid.UUID) uuid.UUID {
	f.t.Helper()
	var id uuid.UUID
	if err := f.pool.QueryRow(f.t.Context(), `SELECT account_id FROM savings_goals WHERE id = $1`, goal).Scan(&id); err != nil {
		f.t.Fatal(err)
	}
	return id
}

func (f *fixture) count(query string, args ...any) int {
	f.t.Helper()
	var n int
	if err := f.pool.QueryRow(f.t.Context(), query, args...).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

func (f *fixture) goal(c customer, target int64, rule *AutoSave) Goal {
	f.t.Helper()
	g, err := f.svc.Create(c.ctx, GoalInput{Name: "Laptop", Emoji: "💻", Target: naira(target), AutoSave: rule})
	if err != nil {
		f.t.Fatal(err)
	}
	return g
}

func wantProblem(t *testing.T, err error, code string) {
	t.Helper()
	var p *problem.Error
	if err == nil || !errors.As(err, &p) || p.Code != code {
		t.Fatalf("err = %v, want problem %q", err, code)
	}
}

func TestAGoalTakesDepositsAndWithdrawalsThroughTheLedger(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(100_000_00)
	g := f.goal(c, 50_000_00, nil)
	if g.Status != "active" || g.Balance.Amount() != 0 || g.InterestRate != defaultGoalRateBps {
		t.Fatalf("new goal = %+v", g)
	}
	got, err := f.svc.Deposit(c.ctx, g.ID, c.ngn, naira(20_000_00))
	if err != nil {
		t.Fatal(err)
	}
	if got.Balance.Amount() != 20_000_00 || got.ProgressPct != 40 {
		t.Fatalf("after deposit = %+v", got)
	}
	if f.balance(c.ngn) != 80_000_00 || f.balance(f.goalAccount(g.ID)) != 20_000_00 {
		t.Fatalf("balances: naira %d, goal %d", f.balance(c.ngn), f.balance(f.goalAccount(g.ID)))
	}
	if n := f.count(`SELECT count(*) FROM transactions WHERE user_id = $1 AND type = 'savings' AND direction = 'debit' AND category = 'savings'`, c.id); n != 1 {
		t.Fatalf("deposit history lines = %d", n)
	}
	got, err = f.svc.Withdraw(c.ctx, g.ID, c.ngn, naira(5_000_00))
	if err != nil || got.Balance.Amount() != 15_000_00 || f.balance(c.ngn) != 85_000_00 {
		t.Fatalf("after withdrawal = %+v, %v", got, err)
	}
	_, err = f.svc.Withdraw(c.ctx, g.ID, c.ngn, naira(15_000_01))
	wantProblem(t, err, "insufficient_funds")
	_, err = f.svc.Deposit(c.ctx, g.ID, c.ngn, naira(900_000_00))
	wantProblem(t, err, "insufficient_funds")
	// Reaching the target completes the goal.
	got, err = f.svc.Deposit(c.ctx, g.ID, c.ngn, naira(35_000_00))
	if err != nil || got.Status != "completed" || got.ProgressPct != 100 {
		t.Fatalf("reached target = %+v, %v", got, err)
	}
}

func TestClosingAGoalPaysTheBalanceBackOnce(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00)
	g := f.goal(c, 5_000_00, &AutoSave{Amount: naira(100_00), Frequency: "daily", Source: c.ngn})
	if _, err := f.svc.Deposit(c.ctx, g.ID, c.ngn, naira(3_000_00)); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.Close(c.ctx, g.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.Close(c.ctx, g.ID); err != nil {
		t.Fatalf("closing twice: %v", err)
	}
	if f.balance(c.ngn) != 10_000_00 || f.balance(f.goalAccount(g.ID)) != 0 {
		t.Fatalf("balances: naira %d, goal %d", f.balance(c.ngn), f.balance(f.goalAccount(g.ID)))
	}
	closed, err := f.svc.Get(c.ctx, g.ID)
	if err != nil || closed.Status != "closed" || closed.AutoSave != nil {
		t.Fatalf("closed goal = %+v, %v", closed, err)
	}
	_, err = f.svc.Deposit(c.ctx, g.ID, c.ngn, naira(100_00))
	wantProblem(t, err, "invalid_state")
	if n := f.count(`SELECT count(*) FROM transactions WHERE user_id = $1 AND narration = 'Closed Laptop'`, c.id); n != 1 {
		t.Fatalf("payback lines = %d, want 1", n)
	}
}

func TestGoalRulesAndOwnership(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00)
	other := f.customer(10_000_00)
	bad := map[string]GoalInput{
		"no name":       {Name: " ", Emoji: "💻", Target: naira(1_000_00)},
		"no emoji":      {Name: "Car", Target: naira(1_000_00)},
		"zero target":   {Name: "Car", Emoji: "🚗", Target: naira(0)},
		"usd target":    {Name: "Car", Emoji: "🚗", Target: money.New(1_000_00, money.USD)},
		"past date":     {Name: "Car", Emoji: "🚗", Target: naira(1_000_00), TargetDate: ptr(time.Date(2026, 11, 10, 0, 0, 0, 0, time.UTC))},
		"other's rule":  {Name: "Car", Emoji: "🚗", Target: naira(1_000_00), AutoSave: &AutoSave{Amount: naira(100_00), Frequency: "daily", Source: other.ngn}},
		"bad frequency": {Name: "Car", Emoji: "🚗", Target: naira(1_000_00), AutoSave: &AutoSave{Amount: naira(100_00), Frequency: "hourly", Source: c.ngn}},
	}
	for name, in := range bad {
		if _, err := f.svc.Create(c.ctx, in); err == nil {
			t.Errorf("%s: expected a refusal", name)
		}
	}
	if n := f.count(`SELECT count(*) FROM savings_goals WHERE user_id = $1`, c.id); n != 0 {
		t.Fatalf("refused goals left %d rows", n)
	}
	g := f.goal(c, 1_000_00, nil)
	// Someone else's goal and account are 404s, never a movement.
	if _, err := f.svc.Get(other.ctx, g.ID); !errors.Is(err, ErrGoalNotFound) {
		t.Fatalf("other's Get err = %v", err)
	}
	if _, err := f.svc.Deposit(other.ctx, g.ID, other.ngn, naira(100_00)); !errors.Is(err, ErrGoalNotFound) {
		t.Fatalf("other's Deposit err = %v", err)
	}
	if _, err := f.svc.Deposit(c.ctx, g.ID, other.ngn, naira(100_00)); err == nil || f.balance(other.ngn) != 10_000_00 {
		t.Fatalf("depositing from another customer's account: err = %v", err)
	}
	if _, err := f.svc.Deposit(c.ctx, g.ID, c.ngn, money.New(100, money.USD)); err == nil {
		t.Fatal("a dollar deposit was accepted")
	}
	for i := 1; i < maxActiveGoals; i++ {
		f.goal(c, 1_000_00, nil)
	}
	_, err := f.svc.Create(c.ctx, GoalInput{Name: "One too many", Emoji: "💸", Target: naira(1_000_00)})
	wantProblem(t, err, problem.CodeValidationFailed)
}

func ptr[T any](v T) *T { return &v }

func TestEditingAGoal(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00)
	rule := &AutoSave{Amount: naira(500_00), Frequency: "weekly", Source: c.ngn}
	g := f.goal(c, 50_000_00, rule)
	day := time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)
	got, err := f.svc.Update(c.ctx, g.ID, Edit{Name: ptr("New laptop"), Target: ptr(naira(80_000_00)), TargetDate: &day})
	if err != nil || got.Name != "New laptop" || got.Target.Amount() != 80_000_00 || got.TargetDate == nil || got.AutoSave == nil {
		t.Fatalf("edited = %+v, %v", got, err)
	}
	// An explicit null removes the rule; leaving it out keeps it.
	got, err = f.svc.Update(c.ctx, g.ID, Edit{ClearAutoSave: true, ClearTargetDate: true})
	if err != nil || got.AutoSave != nil || got.TargetDate != nil {
		t.Fatalf("cleared = %+v, %v", got, err)
	}
	if _, err := f.svc.Update(c.ctx, g.ID, Edit{Name: ptr("")}); err == nil {
		t.Fatal("an empty name was accepted")
	}
}

func TestNextAutoSave(t *testing.T) {
	t.Parallel()
	at := func(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 8, 0, 0, 0, lagos) }
	for name, tc := range map[string]struct {
		from time.Time
		freq string
		want time.Time
	}{
		"daily":                     {at(2026, 11, 11), "daily", at(2026, 11, 12)},
		"weekly":                    {at(2026, 11, 11), "weekly", at(2026, 11, 18)},
		"monthly":                   {at(2026, 11, 11), "monthly", at(2026, 12, 11)},
		"31st lands on a short end": {at(2026, 1, 31), "monthly", at(2026, 2, 28)},
		"leap year":                 {at(2028, 1, 31), "monthly", at(2028, 2, 29)},
		"december rolls the year":   {at(2026, 12, 15), "monthly", at(2027, 1, 15)},
	} {
		if got := nextAutoSave(tc.from.UTC(), tc.freq); !got.Equal(tc.want) {
			t.Errorf("%s: got %v, want %v", name, got.In(lagos), tc.want)
		}
	}
	now := at(2026, 11, 20).UTC()
	if got := after(now, at(2026, 11, 11).UTC(), "daily"); !got.Equal(at(2026, 11, 21)) {
		t.Errorf("after a long outage: %v", got.In(lagos))
	}
}

func TestAutoSaveDepositsOncePerPeriodAndNeverTwice(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00)
	g := f.goal(c, 50_000_00, &AutoSave{Amount: naira(1_000_00), Frequency: "daily", Source: c.ngn})
	if n, err := f.svc.SweepAutoSaves(c.ctx); err != nil || n != 0 {
		t.Fatalf("sweep before the first period = %d, %v", n, err)
	}
	f.clk.advance(25 * time.Hour)
	// Two sweeps (two instances, or a retry) in the same period still save once.
	var wg sync.WaitGroup
	for range 3 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := f.svc.SweepAutoSaves(c.ctx); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if got := f.balance(f.goalAccount(g.ID)); got != 1_000_00 {
		t.Fatalf("goal = %d after three sweeps, want one deposit of 100000", got)
	}
	if n := f.count(`SELECT count(*) FROM outbox_events WHERE topic = $1`, TopicAutoSaved); n != 1 {
		t.Fatalf("auto_saved events = %d", n)
	}
	// A week-long outage is one deposit, not seven.
	f.clk.advance(7 * 24 * time.Hour)
	if n, err := f.svc.SweepAutoSaves(c.ctx); err != nil || n != 1 {
		t.Fatalf("sweep after an outage = %d, %v", n, err)
	}
	if got := f.balance(f.goalAccount(g.ID)); got != 2_000_00 {
		t.Fatalf("goal = %d, want 200000", got)
	}
}

func TestAutoSaveSkipsWhenThereIsNotEnoughAndWhenTheTargetIsMet(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(500_00)
	g := f.goal(c, 50_000_00, &AutoSave{Amount: naira(1_000_00), Frequency: "daily", Source: c.ngn})
	f.clk.advance(25 * time.Hour)
	if n, err := f.svc.SweepAutoSaves(c.ctx); err != nil || n != 0 {
		t.Fatalf("sweep = %d, %v", n, err)
	}
	if f.balance(c.ngn) != 500_00 || f.balance(f.goalAccount(g.ID)) != 0 {
		t.Fatal("a skipped auto-save moved money")
	}
	if n := f.count(`SELECT count(*) FROM outbox_events WHERE topic = $1`, TopicAutoSaveSkipped); n != 1 {
		t.Fatalf("skipped events = %d", n)
	}
	// The skipped period is spent: another sweep now does nothing.
	if _, err := f.svc.SweepAutoSaves(c.ctx); err != nil {
		t.Fatal(err)
	}
	if n := f.count(`SELECT count(*) FROM outbox_events WHERE topic = $1`, TopicAutoSaveSkipped); n != 1 {
		t.Fatalf("skipped events after a second sweep = %d, want 1", n)
	}
	// Topped up, the next period saves.
	f.fund(c.ngn, 5_000_00)
	f.clk.advance(24 * time.Hour)
	if n, err := f.svc.SweepAutoSaves(c.ctx); err != nil || n != 1 {
		t.Fatalf("sweep after top-up = %d, %v", n, err)
	}
	// Once the goal is met, the rule has nothing to do.
	if _, err := f.svc.Deposit(c.ctx, g.ID, c.ngn, naira(3_000_00)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Update(c.ctx, g.ID, Edit{Target: ptr(naira(4_000_00))}); err != nil {
		t.Fatal(err)
	}
	before := f.balance(f.goalAccount(g.ID))
	f.clk.advance(24 * time.Hour)
	if n, err := f.svc.SweepAutoSaves(c.ctx); err != nil || n != 0 || f.balance(f.goalAccount(g.ID)) != before {
		t.Fatalf("sweep on a finished goal = %d, %v", n, err)
	}
}

func TestRoundUpOf(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ spend, step, want int64 }{
		{1_250_00, 100_00, 50_00}, {1_200_00, 100_00, 0}, {1_250_00, 500_00, 250_00}, {1_250_00, 1_000_00, 750_00},
		{1, 100_00, 99_99}, {0, 100_00, 0}, {-5, 100_00, 0}, {500_00, 0, 0},
	} {
		if got := RoundUpOf(tc.spend, tc.step); got != tc.want {
			t.Errorf("RoundUpOf(%d, %d) = %d, want %d", tc.spend, tc.step, got, tc.want)
		}
	}
}

func (f *fixture) roundUps(c customer, goal uuid.UUID, enabled bool, to int64, sources ...string) {
	f.t.Helper()
	in := RoundUpSettings{Enabled: enabled, RoundTo: to, Sources: sources}
	if enabled {
		in.GoalID = &goal
	}
	if _, err := f.svc.SetRoundUps(c.ctx, in); err != nil {
		f.t.Fatal(err)
	}
}

func cardSettled(c customer, auth uuid.UUID, minor int64, currency string, at time.Time) jobs.Delivery {
	p, _ := json.Marshal(map[string]any{
		"user_id": c.id, "account_id": c.ngn, "authorization_id": auth, "merchant_name": "Shoprite",
		"billing_minor": minor, "billing_currency": currency,
	})
	return jobs.Delivery{ID: uuid.New(), Topic: "card.settled", Payload: p, CreatedAt: at}
}

func transferDone(c customer, id uuid.UUID, minor int64, at time.Time) jobs.Delivery {
	p, _ := json.Marshal(map[string]any{
		"transfer_id": id, "user_id": c.id, "source_account_id": c.ngn, "amount_minor": minor, "currency": "NGN", "rail": "internal",
	})
	return jobs.Delivery{ID: uuid.New(), Topic: "transfer.completed", Payload: p, CreatedAt: at}
}

func TestRoundUpsFollowCardAndTransferSpends(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(100_000_00)
	g := f.goal(c, 50_000_00, nil)
	f.roundUps(c, g.ID, true, 100_00, "card", "transfer")
	f.clk.advance(time.Minute)
	sub := f.svc.Subscriber()
	handle := func(d jobs.Delivery) {
		t.Helper()
		if err := sub.Handle(t.Context(), d); err != nil {
			t.Fatal(err)
		}
	}

	card := uuid.New()
	d := cardSettled(c, card, 1_250_00, "NGN", f.clk.Now())
	handle(d)
	handle(d) // the outbox delivers at least once
	if got := f.balance(f.goalAccount(g.ID)); got != 50_00 {
		t.Fatalf("goal = %d after a ₦1,250 card spend, want the ₦50 round-up", got)
	}
	handle(transferDone(c, uuid.New(), 4_030_00, f.clk.Now()))
	if got := f.balance(f.goalAccount(g.ID)); got != 50_00+70_00 {
		t.Fatalf("goal = %d after a transfer, want 12000", got)
	}
	// A round amount, a dollar spend, and a spend that predates the rule add nothing.
	handle(cardSettled(c, uuid.New(), 2_000_00, "NGN", f.clk.Now()))
	handle(cardSettled(c, uuid.New(), 12_50, "USD", f.clk.Now()))
	handle(cardSettled(c, uuid.New(), 1_250_00, "NGN", f.clk.Now().Add(-time.Hour)))
	if got := f.balance(f.goalAccount(g.ID)); got != 120_00 {
		t.Fatalf("goal = %d after spends that should not round up", got)
	}
	if n := f.count(`SELECT count(*) FROM round_ups WHERE user_id = $1`, c.id); n != 2 {
		t.Fatalf("round_ups rows = %d, want 2", n)
	}
	if n := f.count(`SELECT count(*) FROM transactions WHERE user_id = $1 AND narration LIKE 'Round-up:%'`, c.id); n != 2 {
		t.Fatalf("round-up history lines = %d, want 2", n)
	}
	sum, err := f.svc.Summary(c.ctx)
	if err != nil || sum.RoundUpsThisMonth.Amount() != 120_00 || sum.TotalSaved.Amount() != 120_00 || sum.Goals != 1 {
		t.Fatalf("summary = %+v, %v", sum, err)
	}
}

func TestRoundUpsRespectTheRule(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(100_00)
	g := f.goal(c, 50_000_00, nil)
	sub := f.svc.Subscriber()
	handle := func(d jobs.Delivery) {
		t.Helper()
		if err := sub.Handle(t.Context(), d); err != nil {
			t.Fatal(err)
		}
	}
	now := f.clk.Now().Add(time.Minute)
	// No rule yet, then a rule that is off.
	handle(cardSettled(c, uuid.New(), 1_250_00, "NGN", now))
	f.roundUps(c, g.ID, false, 100_00, "card")
	handle(cardSettled(c, uuid.New(), 1_250_00, "NGN", now))
	// Card only: a transfer is not rounded up.
	f.roundUps(c, g.ID, true, 100_00, "card")
	now = f.clk.Now().Add(time.Hour)
	handle(transferDone(c, uuid.New(), 1_250_00, now))
	if got := f.balance(f.goalAccount(g.ID)); got != 0 {
		t.Fatalf("goal = %d, want nothing", got)
	}
	// Not enough left in the account: skipped quietly, nothing half-moved.
	handle(cardSettled(c, uuid.New(), 1_250_00, "NGN", now))
	if got := f.balance(f.goalAccount(g.ID)); got != 50_00 {
		t.Fatalf("goal = %d, want the 5000 the account could cover", got)
	}
	handle(cardSettled(c, uuid.New(), 1_201_00, "NGN", now)) // would round up ₦99, more than the ₦50 left
	if f.balance(c.ngn) != 50_00 {
		t.Fatalf("naira = %d, want 5000 untouched", f.balance(c.ngn))
	}
	// Closing the goal switches the rule off instead of leaving it pointing nowhere.
	if err := f.svc.Close(c.ctx, g.ID); err != nil {
		t.Fatal(err)
	}
	r, err := f.svc.RoundUps(c.ctx)
	if err != nil || r.Enabled || r.GoalID != nil {
		t.Fatalf("round-ups after closing the goal = %+v, %v", r, err)
	}
}

func TestRoundUpSettingsAreValidated(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(0)
	other := f.customer(0)
	g := f.goal(c, 1_000_00, nil)
	theirs := f.goal(other, 1_000_00, nil)
	def, err := f.svc.RoundUps(c.ctx)
	if err != nil || def.Enabled || def.RoundTo != 10_000 || len(def.Sources) != 2 {
		t.Fatalf("default = %+v, %v", def, err)
	}
	_, err = f.svc.SetRoundUps(c.ctx, RoundUpSettings{Enabled: true, RoundTo: 10_000, Sources: []string{"card"}})
	wantProblem(t, err, problem.CodeValidationFailed) // no goal
	_, err = f.svc.SetRoundUps(c.ctx, RoundUpSettings{Enabled: true, RoundTo: 7_000, GoalID: &g.ID, Sources: []string{"card"}})
	wantProblem(t, err, problem.CodeValidationFailed) // odd step
	_, err = f.svc.SetRoundUps(c.ctx, RoundUpSettings{Enabled: true, RoundTo: 10_000, GoalID: &g.ID, Sources: []string{"cash"}})
	wantProblem(t, err, problem.CodeValidationFailed) // unknown source
	if _, err = f.svc.SetRoundUps(c.ctx, RoundUpSettings{Enabled: true, RoundTo: 10_000, GoalID: &theirs.ID, Sources: []string{"card"}}); !errors.Is(err, ErrGoalNotFound) {
		t.Fatalf("round-ups into another customer's goal: %v", err)
	}
	got, err := f.svc.SetRoundUps(c.ctx, RoundUpSettings{Enabled: true, RoundTo: 50_000, GoalID: &g.ID, Sources: []string{"transfer", "card", "card"}})
	if err != nil || !got.Enabled || got.RoundTo != 50_000 || len(got.Sources) != 2 {
		t.Fatalf("saved = %+v, %v", got, err)
	}
}
