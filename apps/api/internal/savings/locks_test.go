package savings

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

const day = 24 * time.Hour

func TestSimpleInterest(t *testing.T) {
	t.Parallel()
	for name, tc := range map[string]struct {
		principal       int64
		rate, days, out int64
	}{
		"₦100,000 at 14% for 90 days, rounded down": {100_000_00, 1_400, 90, 345_205},
		"one day at 10%":                      {100_000_00, 1_000, 1, 2_739},
		"a full year at 18%":                  {50_000_00, 1_800, 365, 900_000},
		"under a kobo earns nothing":          {10, 1_000, 1, 0},
		"no principal":                        {0, 1_000, 30, 0},
		"no days":                             {100_000_00, 1_000, 0, 0},
		"the biggest balance cannot overflow": {maxTarget, 1_800, 365, 18_000_000_000},
	} {
		if got := SimpleInterest(tc.principal, int(tc.rate), int(tc.days)); got != tc.out {
			t.Errorf("%s: got %d, want %d", name, got, tc.out)
		}
	}
}

func TestAQuoteDisclosesTheTermsBeforeLocking(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	q, err := f.svc.Quote(naira(100_000_00), 90)
	if err != nil {
		t.Fatal(err)
	}
	if q.RateBps != 1_400 || q.InterestAtMaturity.Amount() != 345_205 || q.EarlyBreakPenaltyBps != 5_000 ||
		q.MaturityDate.Format(time.DateOnly) != "2027-02-09" || q.Explanation == "" {
		t.Fatalf("quote = %+v", q)
	}
	for name, tc := range map[string]struct {
		amount money.Money
		term   int
	}{
		"a term with no rate": {naira(100_000_00), 45},
		"below the minimum":   {naira(9_999_00), 30},
		"dollars":             {money.New(100_000_00, money.USD), 30},
	} {
		if _, err := f.svc.Quote(tc.amount, tc.term); err == nil {
			t.Errorf("%s: expected a refusal", name)
		}
	}
}

func (f *fixture) lock(c customer, kobo int64, term int) Lock {
	f.t.Helper()
	l, err := f.svc.CreateLock(c.ctx, naira(kobo), term, c.ngn, true)
	if err != nil {
		f.t.Fatal(err)
	}
	return l
}

func (f *fixture) lockAccount(id uuid.UUID) uuid.UUID {
	f.t.Helper()
	var a uuid.UUID
	if err := f.pool.QueryRow(f.t.Context(), `SELECT account_id FROM locked_savings WHERE id = $1`, id).Scan(&a); err != nil {
		f.t.Fatal(err)
	}
	return a
}

func (f *fixture) interestExpense() int64 {
	f.t.Helper()
	var bal int64
	if err := f.pool.QueryRow(f.t.Context(), `SELECT balance_minor FROM ledger_accounts WHERE kind = 'interest_expense' AND currency = 'NGN'`).Scan(&bal); err != nil {
		f.t.Fatal(err)
	}
	return bal
}

func TestLockingMovesMoneyIntoItsOwnAccount(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(500_000_00)
	l := f.lock(c, 100_000_00, 90)
	if l.Status != "active" || l.RateBps != 1_400 || l.ExpectedInterest.Amount() != 345_205 || l.StartDate.Format(time.DateOnly) != "2026-11-11" ||
		l.MaturityDate.Format(time.DateOnly) != "2027-02-09" || l.AccruedInterest.Amount() != 0 || l.PaidOut != nil {
		t.Fatalf("lock = %+v", l)
	}
	if f.balance(c.ngn) != 400_000_00 || f.balance(f.lockAccount(l.ID)) != 100_000_00 {
		t.Fatalf("balances: naira %d, lock %d", f.balance(c.ngn), f.balance(f.lockAccount(l.ID)))
	}
	if n := f.count(`SELECT count(*) FROM transactions WHERE user_id = $1 AND narration = 'Locked savings (90 days)' AND direction = 'debit'`, c.id); n != 1 {
		t.Fatalf("history lines = %d", n)
	}
	// Several locks at once, each in its own account.
	l2 := f.lock(c, 50_000_00, 30)
	if f.lockAccount(l.ID) == f.lockAccount(l2.ID) {
		t.Fatal("two locks share an account")
	}
	list, err := f.svc.Locks(c.ctx)
	if err != nil || len(list) != 2 {
		t.Fatalf("locks = %d, %v", len(list), err)
	}
	sum, err := f.svc.Summary(c.ctx)
	if err != nil || sum.Locks != 2 || sum.TotalSaved.Amount() != 150_000_00 {
		t.Fatalf("summary = %+v, %v", sum, err)
	}
}

func TestLockRulesAndOwnership(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(100_000_00)
	other := f.customer(100_000_00)
	_, err := f.svc.CreateLock(c.ctx, naira(20_000_00), 30, c.ngn, false)
	wantProblem(t, err, problem.CodeValidationFailed) // terms not accepted
	if _, err := f.svc.CreateLock(c.ctx, naira(20_000_00), 30, other.ngn, true); err == nil || f.balance(other.ngn) != 100_000_00 {
		t.Fatalf("locking from another customer's account: %v", err)
	}
	_, err = f.svc.CreateLock(c.ctx, naira(200_000_00), 30, c.ngn, true)
	wantProblem(t, err, "insufficient_funds")
	if n := f.count(`SELECT count(*) FROM locked_savings WHERE user_id = $1`, c.id); n != 0 {
		t.Fatalf("refused locks left %d rows", n)
	}
	l := f.lock(c, 20_000_00, 30)
	if _, err := f.svc.Lock(other.ctx, l.ID); !errors.Is(err, ErrLockNotFound) {
		t.Fatalf("other's Lock err = %v", err)
	}
	if _, err := f.svc.BreakLock(other.ctx, l.ID); !errors.Is(err, ErrLockNotFound) {
		t.Fatalf("other's BreakLock err = %v", err)
	}
}

func TestInterestIsPostedDailyAndACatchUpLandsOnTheSameTotal(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(300_000_00)
	daily := f.lock(c, 100_000_00, 90)
	catchUp := f.lock(c, 100_000_00, 90)

	// Day by day for 40 days; the second lock is skipped by the sweep until the end.
	for range 40 {
		f.clk.advance(day)
		if _, err := f.svc.SweepLocks(c.ctx); err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.SweepLocks(c.ctx); err != nil { // a repeat in the same day posts nothing more
			t.Fatal(err)
		}
	}
	got, err := f.svc.Lock(c.ctx, daily.ID)
	if err != nil || got.AccruedInterest.Amount() != SimpleInterest(100_000_00, 1_400, 40) {
		t.Fatalf("after 40 days: %+v, %v (want %d)", got, err, SimpleInterest(100_000_00, 1_400, 40))
	}
	// The interest is really in the lock's ledger account, from the bank's interest expense.
	if f.balance(f.lockAccount(daily.ID)) != 100_000_00+got.AccruedInterest.Amount() {
		t.Fatalf("lock account = %d", f.balance(f.lockAccount(daily.ID)))
	}
	if f.interestExpense() != -(2 * got.AccruedInterest.Amount()) {
		t.Fatalf("interest expense = %d, want both locks' interest", f.interestExpense())
	}
	other, err := f.svc.Lock(c.ctx, catchUp.ID)
	if err != nil || other.AccruedInterest.Amount() != got.AccruedInterest.Amount() {
		t.Fatalf("both locks should agree: %+v vs %+v", other, got)
	}
	if n := f.count(`SELECT count(*) FROM journal_entries WHERE kind = 'interest_accrual' AND reference = $1`, reference("INT", daily.ID)); n != 40 {
		t.Fatalf("daily lock has %d interest entries, want 40", n)
	}

	// An outage: a third lock sees 50 days in a single sweep and lands on the closed-form total.
	late := f.lock(c, 100_000_00-1_000_00, 90)
	f.clk.advance(50 * day)
	if _, err := f.svc.SweepLocks(c.ctx); err != nil {
		t.Fatal(err)
	}
	l, _ := f.svc.Lock(c.ctx, late.ID)
	if want := SimpleInterest(99_000_00, 1_400, 50); l.AccruedInterest.Amount() != want {
		t.Fatalf("catch-up accrued %d, want %d", l.AccruedInterest.Amount(), want)
	}
	if n := f.count(`SELECT count(*) FROM journal_entries WHERE kind = 'interest_accrual' AND reference = $1`, reference("INT", late.ID)); n != 1 {
		t.Fatalf("catch-up wrote %d entries, want 1", n)
	}
}

func TestAMaturedLockPaysPrincipalAndTheWholeTermsInterest(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(200_000_00)
	l := f.lock(c, 100_000_00, 30)
	f.clk.advance(29 * day)
	if n, err := f.svc.SweepLocks(c.ctx); err != nil || n != 0 {
		t.Fatalf("sweep before maturity = %d, %v", n, err)
	}
	if got, _ := f.svc.Lock(c.ctx, l.ID); got.Status != "active" {
		t.Fatalf("status = %s", got.Status)
	}
	f.clk.advance(day)
	if n, err := f.svc.SweepLocks(c.ctx); err != nil || n != 1 {
		t.Fatalf("sweep at maturity = %d, %v", n, err)
	}
	got, err := f.svc.Lock(c.ctx, l.ID)
	want := 100_000_00 + l.ExpectedInterest.Amount()
	if err != nil || got.Status != "matured" || got.PaidOut == nil || got.PaidOut.Amount() != want || got.AccruedInterest.Amount() != l.ExpectedInterest.Amount() {
		t.Fatalf("matured lock = %+v, %v (want paid out %d)", got, err, want)
	}
	if f.balance(c.ngn) != 100_000_00+want || f.balance(f.lockAccount(l.ID)) != 0 {
		t.Fatalf("balances: naira %d, lock %d", f.balance(c.ngn), f.balance(f.lockAccount(l.ID)))
	}
	if f.interestExpense() != -l.ExpectedInterest.Amount() {
		t.Fatalf("interest expense = %d, want exactly the interest paid", f.interestExpense())
	}
	// Paid out once: a second sweep and a late break change nothing.
	if n, err := f.svc.SweepLocks(c.ctx); err != nil || n != 0 {
		t.Fatalf("second sweep = %d, %v", n, err)
	}
	again, err := f.svc.BreakLock(c.ctx, l.ID)
	if err != nil || again.Status != "matured" || f.balance(c.ngn) != 100_000_00+want {
		t.Fatalf("break after maturity = %+v, %v", again, err)
	}
	if n := f.count(`SELECT count(*) FROM transactions WHERE user_id = $1 AND type = 'interest'`, c.id); n != 1 {
		t.Fatalf("interest lines = %d", n)
	}
	if n := f.count(`SELECT count(*) FROM outbox_events WHERE topic = $1`, TopicLockMatured); n != 1 {
		t.Fatalf("matured events = %d", n)
	}
}

func TestBreakingEarlyKeepsThePrincipalAndHalfTheInterest(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(200_000_00)
	l := f.lock(c, 100_000_00, 90)
	f.clk.advance(40 * day) // not swept: breaking catches the interest up itself
	got, err := f.svc.BreakLock(c.ctx, l.ID)
	if err != nil {
		t.Fatal(err)
	}
	accrued := SimpleInterest(100_000_00, 1_400, 40)
	kept := (accrued*5_000 + 9_999) / 10_000 // rounded up, in the customer's favour
	if got.Status != "broken" || got.PaidOut == nil || got.PaidOut.Amount() != 100_000_00+kept || got.AccruedInterest.Amount() != kept {
		t.Fatalf("broken lock = %+v (accrued %d, kept %d)", got, accrued, kept)
	}
	if f.balance(c.ngn) != 200_000_00+kept || f.balance(f.lockAccount(l.ID)) != 0 {
		t.Fatalf("balances: naira %d, lock %d", f.balance(c.ngn), f.balance(f.lockAccount(l.ID)))
	}
	// The bank paid only what the customer kept: the forfeited half went back to expense.
	if f.interestExpense() != -kept {
		t.Fatalf("interest expense = %d, want %d", f.interestExpense(), -kept)
	}
	var fee int64
	var code string
	if err := f.pool.QueryRow(t.Context(), `SELECT fee_minor, fee_code FROM transactions WHERE user_id = $1 AND type = 'interest'`, c.id).Scan(&fee, &code); err != nil ||
		fee != accrued-kept || code != "early_break_penalty" {
		t.Fatalf("penalty line = %d %q (%v), want %d", fee, code, err, accrued-kept)
	}
	// Breaking twice pays nothing more.
	if _, err := f.svc.BreakLock(c.ctx, l.ID); err != nil || f.balance(c.ngn) != 200_000_00+kept {
		t.Fatalf("second break: %v, naira %d", err, f.balance(c.ngn))
	}
	if n := f.count(`SELECT count(*) FROM outbox_events WHERE topic = $1`, TopicLockBroken); n != 1 {
		t.Fatalf("broken events = %d", n)
	}
}

func TestBreakingBeforeAnyInterestReturnsTheFullPrincipal(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(100_000_00)
	l := f.lock(c, 100_000_00, 365)
	got, err := f.svc.BreakLock(c.ctx, l.ID)
	if err != nil || got.Status != "broken" || got.PaidOut.Amount() != 100_000_00 || f.balance(c.ngn) != 100_000_00 {
		t.Fatalf("immediate break = %+v, %v, naira %d", got, err, f.balance(c.ngn))
	}
	if n := f.count(`SELECT count(*) FROM transactions WHERE user_id = $1 AND type = 'interest'`, c.id); n != 0 {
		t.Fatalf("interest lines = %d, want none", n)
	}
}

func TestGoalsEarnDailyInterestThroughTheLedger(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(300_000_00)
	g := f.goal(c, 500_000_00, nil)
	empty := f.goal(c, 500_000_00, nil)
	closed := f.goal(c, 500_000_00, nil)
	for _, id := range []uuid.UUID{g.ID, closed.ID} {
		if _, err := f.svc.Deposit(c.ctx, id, c.ngn, naira(100_000_00)); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.svc.Close(c.ctx, closed.ID); err != nil {
		t.Fatal(err)
	}
	if n, err := f.svc.SweepGoalInterest(c.ctx); err != nil || n != 0 {
		t.Fatalf("sweep on the day = %d, %v", n, err)
	}
	f.clk.advance(day)
	if n, err := f.svc.SweepGoalInterest(c.ctx); err != nil || n != 1 {
		t.Fatalf("sweep next day = %d, %v (only the funded, open goal earns)", n, err)
	}
	one := SimpleInterest(100_000_00, 1_000, 1)
	got, _ := f.svc.Get(c.ctx, g.ID)
	if got.InterestEarned.Amount() != one || got.Balance.Amount() != 100_000_00+one {
		t.Fatalf("goal = %+v, want one day's interest %d", got, one)
	}
	if _, err := f.svc.SweepGoalInterest(c.ctx); err != nil {
		t.Fatal(err)
	}
	if again, _ := f.svc.Get(c.ctx, g.ID); again.Balance.Amount() != got.Balance.Amount() {
		t.Fatal("a second sweep on the same day paid again")
	}
	if e, _ := f.svc.Get(c.ctx, empty.ID); e.InterestEarned.Amount() != 0 {
		t.Fatalf("empty goal earned %d", e.InterestEarned.Amount())
	}
	if f.interestExpense() != -one {
		t.Fatalf("interest expense = %d, want %d", f.interestExpense(), -one)
	}
	// Three days missed: one catch-up entry on the balance then.
	f.clk.advance(3 * day)
	if _, err := f.svc.SweepGoalInterest(c.ctx); err != nil {
		t.Fatal(err)
	}
	later, _ := f.svc.Get(c.ctx, g.ID)
	if want := one + SimpleInterest(100_000_00+one, 1_000, 3); later.InterestEarned.Amount() != want {
		t.Fatalf("after catch-up earned %d, want %d", later.InterestEarned.Amount(), want)
	}
	sum, err := f.svc.Summary(c.ctx)
	if err != nil || sum.InterestEarned.Amount() != later.InterestEarned.Amount() {
		t.Fatalf("summary interest = %+v, %v", sum, err)
	}
}
