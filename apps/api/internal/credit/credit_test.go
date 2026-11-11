package credit

import (
	"context"
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
	"github.com/onielsteve2003/nem-bank/apps/api/internal/credit/creditdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

const day = 24 * time.Hour

type customers struct {
	mu   sync.Mutex
	tier map[uuid.UUID]int
}

func (c *customers) CustomerProfile(_ context.Context, id uuid.UUID) (identity.CustomerProfile, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if t, ok := c.tier[id]; ok {
		return identity.CustomerProfile{Name: "Test", KycTier: t}, nil
	}
	return identity.CustomerProfile{Name: "Test", KycTier: 3}, nil
}

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

type fixture struct {
	t    *testing.T
	pool *pgxpool.Pool
	svc  *Service
	cust *customers
	clk  *clock
	n    atomic.Int64
}

func newFixture(t *testing.T, scorer Scorer) *fixture {
	t.Helper()
	pool := testdb.New(t)
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	cust := &customers{tier: map[uuid.UUID]int{}}
	clk := &clock{t: time.Date(2026, 11, 11, 9, 0, 0, 0, time.UTC)}
	accts, err := accounts.NewService(accounts.Config{Pool: pool, Customers: cust, Logger: quiet})
	if err != nil {
		t.Fatal(err)
	}
	svc, err := NewService(Config{Pool: pool, Accounts: accts, Customers: cust, Scorer: scorer, Logger: quiet, Now: clk.Now})
	if err != nil {
		t.Fatal(err)
	}
	return &fixture{t: t, pool: pool, svc: svc, cust: cust, clk: clk}
}

type user struct {
	ctx context.Context
	id  uuid.UUID
	ngn uuid.UUID
}

// user opens a customer whose account is 200 days old, with a ₦400,000 monthly salary
// (three credits in the last 92 days) when salary is true, and balance kobo on top.
func (f *fixture) user(salary bool, balance int64) user {
	f.t.Helper()
	ctx := f.t.Context()
	id := uuid.New()
	n := f.n.Add(1)
	if _, err := f.pool.Exec(ctx, `INSERT INTO users (id, first_name, last_name, email, phone, nemtag, date_of_birth,
		password_hash, terms_version, privacy_version, consent_accepted_at, created_at)
		VALUES ($1, 'Ada', 'User', $2, $3, $4, '1996-04-12', 'x', '2026-10', '2026-10', now(), $5)`,
		id, fmt.Sprintf("credit%d@example.com", n), fmt.Sprintf("+2348066%06d", n), fmt.Sprintf("credit%d", n), f.clk.Now().Add(-200*day)); err != nil {
		f.t.Fatal(err)
	}
	if err := pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		return accounts.OpenCurrentAccount(ctx, tx, identity.NewCustomer{UserID: id, Name: "Ada User"})
	}); err != nil {
		f.t.Fatal(err)
	}
	u := user{ctx: identity.WithPrincipal(ctx, identity.Principal{UserID: id}), id: id}
	if err := f.pool.QueryRow(ctx, `SELECT account_id FROM customer_accounts WHERE user_id = $1 AND currency = 'NGN'`, id).Scan(&u.ngn); err != nil {
		f.t.Fatal(err)
	}
	if salary {
		for _, ago := range []time.Duration{60 * day, 30 * day, day} {
			f.credit(u, 400_000_00, "salary_income", f.clk.Now().Add(-ago))
		}
	}
	if balance > 0 {
		f.credit(u, balance, "other", f.clk.Now())
	}
	return u
}

// credit pays kobo into the account from the demo funding account and writes the history line.
func (f *fixture) credit(u user, kobo int64, category string, at time.Time) {
	f.t.Helper()
	ctx := f.t.Context()
	err := pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		src, err := ledger.SystemAccount(ctx, tx, ledger.KindDemoFunding, "NGN")
		if err != nil {
			return err
		}
		amt := money.New(kobo, money.NGN)
		posted, err := ledger.Post(ctx, tx, ledger.Entry{
			Kind: "demo_funding", Reference: "seed", Legs: []ledger.Leg{ledger.Debit(src.ID, amt), ledger.Credit(u.ngn, amt)},
		})
		if err != nil {
			return err
		}
		_, err = accounts.Record(ctx, tx, accounts.Line{
			UserID: u.id, AccountID: u.ngn, Type: "deposit", Direction: "credit", Status: "completed", Amount: amt, Entry: &posted,
			Narration: "seed", Reference: "seed", Category: category, At: at,
		})
		return err
	})
	if err != nil {
		f.t.Fatal(err)
	}
}

// drain takes everything but keep out of the account.
func (f *fixture) drain(u user, keep int64) {
	f.t.Helper()
	ctx := f.t.Context()
	err := pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		bal, err := ledger.GetBalances(ctx, tx, u.ngn)
		if err != nil {
			return err
		}
		sink, err := ledger.SystemAccount(ctx, tx, ledger.KindDemoFunding, "NGN")
		if err != nil {
			return err
		}
		amt := money.New(bal.Available.Amount()-keep, money.NGN)
		_, err = ledger.Post(ctx, tx, ledger.Entry{Kind: "demo_funding", Reference: "drain", Legs: []ledger.Leg{ledger.Debit(u.ngn, amt), ledger.Credit(sink.ID, amt)}})
		return err
	})
	if err != nil {
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

func (f *fixture) systemBalance(kind string) int64 {
	f.t.Helper()
	var bal int64
	if err := f.pool.QueryRow(f.t.Context(), `SELECT balance_minor FROM ledger_accounts WHERE owner_type = 'system' AND kind = $1 AND currency = 'NGN'`, kind).Scan(&bal); err != nil {
		f.t.Fatal(err)
	}
	return bal
}

func (f *fixture) events(topic string) int {
	f.t.Helper()
	var n int
	if err := f.pool.QueryRow(f.t.Context(), `SELECT count(*) FROM outbox_events WHERE topic = $1`, topic).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

// borrow takes a ₦100,000 loan over 60 days.
func (f *fixture) borrow(u user, autoRepay bool) Loan {
	f.t.Helper()
	o, err := f.svc.CreateOffer(u.ctx, naira(100_000_00), 60)
	if err != nil {
		f.t.Fatalf("offer: %v", err)
	}
	l, err := f.svc.Accept(u.ctx, o.ID, u.ngn, autoRepay)
	if err != nil {
		f.t.Fatalf("accept: %v", err)
	}
	return l
}

func reasonCodes(rs []Reason) map[string]string {
	out := map[string]string{}
	for _, r := range rs {
		out[r.Code] = r.Impact
	}
	return out
}

func TestEligibilityIsScoredWithReasons(t *testing.T) {
	f := newFixture(t, nil)

	none := f.user(false, 0)
	e, err := f.svc.Eligibility(none.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if e.Eligible || e.Max.Amount() != 0 || e.Band != "poor" || reasonCodes(e.Reasons)["no_salary"] != "negative" {
		t.Fatalf("no salary should be refused with a reason: %+v", e)
	}

	paid := f.user(true, 0)
	e, err = f.svc.Eligibility(paid.ctx)
	if err != nil {
		t.Fatal(err)
	}
	// 30% of ₦400,000 is ₦120,000, already a multiple of ₦5,000.
	if !e.Eligible || e.Max.Amount() != 120_000_00 || e.Band != "fair" || reasonCodes(e.Reasons)["regular_salary"] != "positive" {
		t.Fatalf("salaried customer: %+v", e)
	}
	if !e.AI.FallbackUsed || e.AI.ModelVersion == "" || e.AI.Explanation == "" {
		t.Fatalf("the AI badge needs a model, an explanation and the fallback flag: %+v", e.AI)
	}

	t.Run("an account under 30 days old borrows half", func(t *testing.T) {
		young := f.user(true, 0)
		if _, err := f.pool.Exec(t.Context(), `UPDATE users SET created_at = $2 WHERE id = $1`, young.id, f.clk.Now().Add(-5*day)); err != nil {
			t.Fatal(err)
		}
		e, err := f.svc.Eligibility(young.ctx)
		if err != nil {
			t.Fatal(err)
		}
		if e.Max.Amount() != 60_000_00 || reasonCodes(e.Reasons)["low_account_age"] != "negative" {
			t.Fatalf("young account: %+v", e)
		}
	})

	t.Run("policy overrules the scorer below KYC tier 3", func(t *testing.T) {
		low := f.user(true, 0)
		f.cust.mu.Lock()
		f.cust.tier[low.id] = 2
		f.cust.mu.Unlock()
		e, err := f.svc.Eligibility(low.ctx)
		if err != nil {
			t.Fatal(err)
		}
		if e.Eligible || e.Max.Amount() != 0 || reasonCodes(e.Reasons)["kyc_tier"] != "negative" {
			t.Fatalf("tier 2: %+v", e)
		}
		if _, err := f.svc.CreateOffer(low.ctx, naira(10_000_00), 30); !errors.Is(err, errNotEligible) {
			t.Fatalf("offer at tier 2: %v", err)
		}
	})
}

type generous struct{}

func (generous) Score(context.Context, Facts) (Assessment, error) {
	return Assessment{Band: "excellent", Max: naira(maxLoan), Meta: Meta{ModelVersion: "test", Explanation: "always yes"}}, nil
}

func TestAScorerCannotLendAgainstPolicy(t *testing.T) {
	f := newFixture(t, generous{})
	u := f.user(false, 0)
	f.cust.mu.Lock()
	f.cust.tier[u.id] = 1
	f.cust.mu.Unlock()
	e, err := f.svc.Eligibility(u.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if e.Eligible || e.Max.Amount() != 0 {
		t.Fatalf("a model saying yes must not beat the tier rule: %+v", e)
	}
}

func TestOfferPricingIsDisclosedUpFront(t *testing.T) {
	f := newFixture(t, nil)
	u := f.user(true, 0)

	o, err := f.svc.CreateOffer(u.ctx, naira(100_000_00), 60)
	if err != nil {
		t.Fatal(err)
	}
	// ₦100,000 at 26% for 60 days is ₦4,273.97 of interest, plus the 1% fee of ₦1,000.
	if o.Terms.AprBps != 2_600 || o.Terms.Interest.Amount() != 427_397 || o.Terms.Fee.Amount() != 100_000 || o.Terms.Total.Amount() != 10_527_397 {
		t.Fatalf("terms: %+v", o.Terms)
	}
	if len(o.Schedule) != 2 || o.Schedule[0].Amount.Amount() != 5_263_698 || o.Schedule[1].Amount.Amount() != 5_263_699 {
		t.Fatalf("schedule: %+v", o.Schedule)
	}
	if got := o.Schedule[0].Due.Format(time.DateOnly); got != "2026-12-11" {
		t.Fatalf("first instalment is 30 days out, got %s", got)
	}
	if !o.ExpiresAt.Equal(f.clk.Now().Add(10 * time.Minute)) {
		t.Fatalf("expires at %s", o.ExpiresAt)
	}

	for name, tc := range map[string]struct {
		amount int64
		tenor  int
		want   error
	}{
		"above the ceiling":     {130_000_00, 60, errTooMuch},
		"below the minimum":     {1_000_00, 60, errAmount},
		"not a ₦5,000 step":     {12_345_00, 60, errAmount},
		"a tenor we don't sell": {10_000_00, 45, errTenor},
	} {
		if _, err := f.svc.CreateOffer(u.ctx, naira(tc.amount), tc.tenor); !errors.Is(err, tc.want) {
			t.Errorf("%s: %v, want %v", name, err, tc.want)
		}
	}
	if _, err := f.svc.CreateOffer(u.ctx, money.New(100_000_00, money.USD), 60); !errors.Is(err, errAmount) {
		t.Errorf("a dollar loan: %v", err)
	}
	if bal := f.balance(u.ngn); bal != 120_000_000 {
		t.Errorf("an offer moves no money, balance %d", bal)
	}
}

func TestAcceptDisbursesAndBooksTheDebt(t *testing.T) {
	f := newFixture(t, nil)
	u := f.user(true, 0)
	before := f.balance(u.ngn)
	interestBefore, feeBefore := f.systemBalance("interest_income"), f.systemBalance("fee_income")

	l := f.borrow(u, true)
	if l.Principal.Amount() != 100_000_00 || l.Outstanding.Amount() != 10_527_397 || l.Status != "active" || !l.AutoRepay {
		t.Fatalf("loan: %+v", l)
	}
	if l.NextDue == nil || l.NextDue.Number != 1 || len(l.Schedule) != 2 {
		t.Fatalf("schedule: %+v", l)
	}
	if l.Payoff == nil || l.Payoff.Amount() >= l.Outstanding.Amount() {
		t.Fatalf("payoff should be below what is owed: %+v", l.Payoff)
	}
	if got := f.balance(u.ngn) - before; got != 100_000_00 {
		t.Fatalf("customer received %d", got)
	}
	var loanBal int64
	if err := f.pool.QueryRow(t.Context(), `SELECT balance_minor FROM ledger_accounts WHERE owner_id = $1 AND kind = 'customer_loan'`, u.id).Scan(&loanBal); err != nil {
		t.Fatal(err)
	}
	if loanBal != -10_527_397 {
		t.Fatalf("the loan account holds the debt as a debit, got %d", loanBal)
	}
	if f.systemBalance("interest_income")-interestBefore != 427_397 || f.systemBalance("fee_income")-feeBefore != 100_000 {
		t.Fatal("interest and fee should be booked as income")
	}
	if f.events(TopicDisbursed) != 1 {
		t.Fatal("expected one disbursed event")
	}
	var lines int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM transactions WHERE user_id = $1 AND type = 'loan_disbursement'`, u.id).Scan(&lines); err != nil || lines != 1 {
		t.Fatalf("history lines %d, %v", lines, err)
	}
	if drift, err := ledger.Drift(t.Context(), f.pool); err != nil || len(drift) != 0 {
		t.Fatalf("ledger drift %v, %v", drift, err)
	}
}

func TestAcceptingTwiceMakesOneLoan(t *testing.T) {
	f := newFixture(t, nil)
	u := f.user(true, 0)
	o, err := f.svc.CreateOffer(u.ctx, naira(50_000_00), 30)
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]uuid.UUID, 6)
	var wg sync.WaitGroup
	for i := range ids {
		wg.Add(1)
		go func() {
			defer wg.Done()
			l, err := f.svc.Accept(u.ctx, o.ID, u.ngn, false)
			if err != nil {
				t.Errorf("accept %d: %v", i, err)
				return
			}
			ids[i] = l.ID
		}()
	}
	wg.Wait()
	for _, id := range ids {
		if id != ids[0] {
			t.Fatalf("every tap should get the same loan: %v", ids)
		}
	}
	var n int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM loans WHERE user_id = $1`, u.id).Scan(&n); err != nil || n != 1 {
		t.Fatalf("loans %d, %v", n, err)
	}
	if got := f.balance(u.ngn) - 120_000_000; got != 50_000_00 {
		t.Fatalf("paid out once, got %d", got)
	}
}

func TestOneLoanAtATimeAndExpiredOffers(t *testing.T) {
	f := newFixture(t, nil)
	u := f.user(true, 0)

	second, err := f.svc.CreateOffer(u.ctx, naira(20_000_00), 30)
	if err != nil {
		t.Fatal(err)
	}
	f.borrow(u, false)
	if _, err := f.svc.Accept(u.ctx, second.ID, u.ngn, false); !errors.Is(err, errNotEligible) {
		t.Fatalf("a second loan: %v", err)
	}
	if _, err := f.svc.CreateOffer(u.ctx, naira(20_000_00), 30); !errors.Is(err, errNotEligible) {
		t.Fatalf("an offer while a loan is open: %v", err)
	}

	v := f.user(true, 0)
	o, err := f.svc.CreateOffer(v.ctx, naira(20_000_00), 30)
	if err != nil {
		t.Fatal(err)
	}
	f.clk.advance(11 * time.Minute)
	if _, err := f.svc.Accept(v.ctx, o.ID, v.ngn, false); !errors.Is(err, errExpired) {
		t.Fatalf("an offer after ten minutes: %v", err)
	}

	w := f.user(true, 0)
	ow, err := f.svc.CreateOffer(w.ctx, naira(20_000_00), 30)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Accept(v.ctx, ow.ID, v.ngn, false); !errors.Is(err, ErrOfferNotFound) {
		t.Fatalf("someone else's offer: %v", err)
	}
	f.cust.mu.Lock()
	f.cust.tier[w.id] = 2
	f.cust.mu.Unlock()
	if _, err := f.svc.Accept(w.ctx, ow.ID, w.ngn, false); !errors.Is(err, errTier) {
		t.Fatalf("accepting below tier 3: %v", err)
	}
}

func TestRepaymentsPartialAndExactPayoff(t *testing.T) {
	f := newFixture(t, nil)
	u := f.user(true, 5_000_000_00)
	l := f.borrow(u, false)

	if _, err := f.svc.Repay(u.ctx, l.ID, u.ngn, naira(0)); err == nil {
		t.Fatal("a zero repayment should be refused")
	}
	if _, err := f.svc.Repay(u.ctx, l.ID, u.ngn, naira(l.Outstanding.Amount()+1)); !errors.Is(err, errTooMuchPaid) {
		t.Fatalf("overpaying: %v", err)
	}

	// Part of the first instalment, then the rest of it and a little of the second.
	l, err := f.svc.Repay(u.ctx, l.ID, u.ngn, naira(2_000_000))
	if err != nil {
		t.Fatal(err)
	}
	if l.Schedule[0].Paid.Amount() != 2_000_000 || l.Schedule[0].Status != "upcoming" || l.Outstanding.Amount() != 10_527_397-2_000_000 {
		t.Fatalf("after a partial repayment: %+v", l)
	}
	l, err = f.svc.Repay(u.ctx, l.ID, u.ngn, naira(3_500_000))
	if err != nil {
		t.Fatal(err)
	}
	if l.Schedule[0].Status != "paid" || l.Schedule[1].Paid.Amount() != 5_500_000-5_263_698 || l.NextDue.Number != 2 {
		t.Fatalf("payment spills into the next instalment: %+v", l.Schedule)
	}

	// Ten days in, paying off early gives back the interest for the 50 days not used.
	f.clk.advance(10 * day)
	l, err = f.svc.Loan(u.ctx, l.ID)
	if err != nil {
		t.Fatal(err)
	}
	owed := l.Outstanding.Amount()
	rebate := owed - l.Payoff.Amount()
	// 427,397 × 50 ÷ 60 rounds up to 356,165, but only 204,105 of interest is left inside
	// the ₦50,273.97 still owed, so that is all that comes back.
	if rebate != 204_105 {
		t.Fatalf("rebate %d", rebate)
	}
	incomeBefore, balBefore := f.systemBalance("interest_income"), f.balance(u.ngn)
	l, err = f.svc.Repay(u.ctx, l.ID, u.ngn, *l.Payoff)
	if err != nil {
		t.Fatal(err)
	}
	if l.Status != "repaid" || l.Outstanding.Amount() != 0 || l.Payoff != nil || l.NextDue != nil {
		t.Fatalf("paid off: %+v", l)
	}
	for _, it := range l.Schedule {
		if it.Status != "paid" || it.Paid.Amount() != it.Amount.Amount() {
			t.Fatalf("every instalment is settled: %+v", l.Schedule)
		}
	}
	if got := incomeBefore - f.systemBalance("interest_income"); got != rebate {
		t.Fatalf("interest income gave back %d, want %d", got, rebate)
	}
	if got := balBefore - f.balance(u.ngn); got != owed-rebate {
		t.Fatalf("customer paid %d, want %d", got, owed-rebate)
	}
	if f.events(TopicRepaid) != 1 || f.events(TopicRepayment) != 2 {
		t.Fatalf("events: repaid %d, repayment %d", f.events(TopicRepaid), f.events(TopicRepayment))
	}
	if _, err := f.svc.Repay(u.ctx, l.ID, u.ngn, naira(100)); !errors.Is(err, errRepaid) {
		t.Fatalf("repaying a repaid loan: %v", err)
	}
	if drift, err := ledger.Drift(t.Context(), f.pool); err != nil || len(drift) != 0 {
		t.Fatalf("ledger drift %v, %v", drift, err)
	}

	// Having repaid, the customer can borrow again, and the repayment counts in their favour.
	e, err := f.svc.Eligibility(u.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !e.Eligible || reasonCodes(e.Reasons)["repayment_history"] != "positive" {
		t.Fatalf("after repaying: %+v", e)
	}
	if again := f.borrow(u, false); again.ID == l.ID {
		t.Fatal("a new loan, not the old one")
	}
}

func TestAutoRepayCollectsDueInstalments(t *testing.T) {
	f := newFixture(t, nil)
	u := f.user(true, 1_000_000_00)
	l := f.borrow(u, true)

	if err := f.svc.Sweep(t.Context()); err != nil {
		t.Fatal(err)
	}
	if l, _ = f.svc.Loan(u.ctx, l.ID); l.Outstanding.Amount() != 10_527_397 {
		t.Fatal("nothing is due on day one")
	}

	f.clk.advance(30 * day)
	for range 2 { // a second sweep the same day collects nothing more
		if err := f.svc.Sweep(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	l, _ = f.svc.Loan(u.ctx, l.ID)
	if l.Schedule[0].Status != "paid" || l.Outstanding.Amount() != 5_263_699 || l.Status != "active" {
		t.Fatalf("first instalment collected: %+v", l)
	}

	f.clk.advance(30 * day)
	if err := f.svc.Sweep(t.Context()); err != nil {
		t.Fatal(err)
	}
	l, _ = f.svc.Loan(u.ctx, l.ID)
	if l.Status != "repaid" || l.Outstanding.Amount() != 0 || f.events(TopicRepaid) != 1 {
		t.Fatalf("second instalment collected: %+v", l)
	}
	if f.events(TopicOverdue) != 0 {
		t.Fatal("nothing was overdue")
	}
}

func TestAutoRepayTakesWhatTheAccountHasAndRetries(t *testing.T) {
	f := newFixture(t, nil)
	u := f.user(true, 0)
	l := f.borrow(u, true)
	f.drain(u, 1_000_000) // ₦10,000 left; the first instalment is ₦52,636.98

	f.clk.advance(30 * day)
	if err := f.svc.Sweep(t.Context()); err != nil {
		t.Fatal(err)
	}
	l, _ = f.svc.Loan(u.ctx, l.ID)
	if l.Schedule[0].Paid.Amount() != 1_000_000 || l.Status != "active" {
		t.Fatalf("part of the instalment is better than none: %+v", l.Schedule)
	}

	f.clk.advance(day)
	if err := f.svc.Sweep(t.Context()); err != nil { // an empty account is not an error
		t.Fatal(err)
	}
	if f.events(TopicOverdue) != 1 {
		t.Fatalf("overdue events %d", f.events(TopicOverdue))
	}
	l, _ = f.svc.Loan(u.ctx, l.ID)
	if l.Status != "overdue" || l.Schedule[0].Status != "overdue" {
		t.Fatalf("a missed instalment makes the loan overdue: %+v", l)
	}

	f.credit(u, 100_000_00, "other", f.clk.Now())
	if err := f.svc.Sweep(t.Context()); err != nil {
		t.Fatal(err)
	}
	l, _ = f.svc.Loan(u.ctx, l.ID)
	if l.Schedule[0].Status != "paid" || l.Status != "active" {
		t.Fatalf("topping up clears the overdue instalment on the next sweep: %+v", l)
	}
	if f.events(TopicOverdue) != 1 {
		t.Fatal("the customer is told once")
	}
}

func TestOverdueLoansDefaultAndStayOnRecord(t *testing.T) {
	f := newFixture(t, nil)
	u := f.user(true, 0)
	l := f.borrow(u, false)

	f.clk.advance(31 * day)
	for range 2 {
		if err := f.svc.Sweep(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	if l, _ = f.svc.Loan(u.ctx, l.ID); l.Status != "overdue" {
		t.Fatalf("status %s", l.Status)
	}
	if f.events(TopicOverdue) != 1 {
		t.Fatalf("overdue events %d", f.events(TopicOverdue))
	}

	f.clk.advance(60 * day)
	if err := f.svc.Sweep(t.Context()); err != nil {
		t.Fatal(err)
	}
	l, _ = f.svc.Loan(u.ctx, l.ID)
	if l.Status != "defaulted" || f.events(TopicDefaulted) != 1 {
		t.Fatalf("after 60 days overdue: %s, events %d", l.Status, f.events(TopicDefaulted))
	}
	if err := f.svc.Sweep(t.Context()); err != nil || f.events(TopicDefaulted) != 1 {
		t.Fatalf("defaulting happens once: %v", err)
	}

	e, _ := f.svc.Eligibility(u.ctx)
	if e.Eligible || reasonCodes(e.Reasons)["past_default"] != "negative" {
		t.Fatalf("a defaulter cannot borrow: %+v", e)
	}

	// The debt can still be cleared; the default stays on record.
	f.credit(u, 200_000_00, "other", f.clk.Now())
	l, err := f.svc.Repay(u.ctx, l.ID, u.ngn, l.Outstanding)
	if err != nil || l.Status != "repaid" {
		t.Fatalf("clearing a defaulted loan: %+v, %v", l, err)
	}
	e, _ = f.svc.Eligibility(u.ctx)
	if e.Eligible || reasonCodes(e.Reasons)["past_default"] != "negative" {
		t.Fatalf("repaying late does not erase the default: %+v", e)
	}
}

func TestListingLoansAndAutoRepaySwitch(t *testing.T) {
	f := newFixture(t, nil)
	u := f.user(true, 1_000_000_00)
	other := f.user(true, 0)
	l := f.borrow(u, true)

	l, err := f.svc.SetAutoRepay(u.ctx, l.ID, false)
	if err != nil || l.AutoRepay {
		t.Fatalf("switch off: %+v, %v", l, err)
	}
	f.clk.advance(31 * day)
	if err := f.svc.Sweep(t.Context()); err != nil {
		t.Fatal(err)
	}
	if l, _ = f.svc.Loan(u.ctx, l.ID); l.Outstanding.Amount() != 10_527_397 {
		t.Fatal("with auto-repay off nothing is collected")
	}

	list, err := f.svc.Loans(u.ctx)
	if err != nil || len(list) != 1 || list[0].ID != l.ID || len(list[0].Schedule) != 2 {
		t.Fatalf("list: %+v, %v", list, err)
	}
	if empty, err := f.svc.Loans(other.ctx); err != nil || len(empty) != 0 {
		t.Fatalf("nobody else's loans: %+v, %v", empty, err)
	}
	if _, err := f.svc.Loan(other.ctx, l.ID); !errors.Is(err, ErrLoanNotFound) {
		t.Fatalf("someone else's loan: %v", err)
	}
	if _, err := f.svc.Repay(other.ctx, l.ID, other.ngn, naira(100)); !errors.Is(err, ErrLoanNotFound) {
		t.Fatalf("repaying someone else's loan: %v", err)
	}
}

func TestPayoffNeverExceedsInterestStillOwed(t *testing.T) {
	start := time.Date(2026, 11, 11, 0, 0, 0, 0, time.UTC)
	l := creditdb.Loan{StartDate: start, TenorDays: 60, InterestMinor: 427_397, TotalMinor: 10_527_397}
	for _, tc := range []struct {
		name       string
		owed, days int64
		want       int64
	}{
		{"day one, all owed", 10_527_397, 0, 427_397},
		{"half way", 10_527_397, 30, 213_699},
		{"the last day", 10_527_397, 59, 7_124},
		{"after the tenor", 10_527_397, 90, 0},
		{"almost repaid: capped to the interest left in the debt", 100_000, 1, 4_059},
		{"nothing owed", 0, 5, 0},
	} {
		if got := payoff(l, tc.owed, start.Add(time.Duration(tc.days)*day)); got != tc.want {
			t.Errorf("%s: rebate %d, want %d", tc.name, got, tc.want)
		}
	}
}
