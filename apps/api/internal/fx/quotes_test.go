package fx

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/limits"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

// profiles is the customers' KYC tiers, settable per test.
type profiles struct {
	mu sync.Mutex
	m  map[uuid.UUID]identity.CustomerProfile
}

func (p *profiles) CustomerProfile(_ context.Context, id uuid.UUID) (identity.CustomerProfile, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.m[id], nil
}

func (p *profiles) setTier(id uuid.UUID, tier int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.m[id] = identity.CustomerProfile{Name: "Test Customer", KycTier: tier}
}

type fixture struct {
	t     *testing.T
	pool  *pgxpool.Pool
	clk   *clock
	svc   *Service
	accts *accounts.Service
	profs *profiles
	n     atomic.Int64
}

// newFixture builds the FX service on real accounts and a ledger, with rates already read:
// USD-NGN 1600, GBP-NGN 2000 and EUR-NGN 1777.77777778 mid, a 1.5% spread.
func newFixture(t *testing.T) *fixture {
	t.Helper()
	pool := testdb.New(t)
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	f := &fixture{t: t, pool: pool, clk: newClock(), profs: &profiles{m: map[uuid.UUID]identity.CustomerProfile{}}}
	var err error
	if f.accts, err = accounts.NewService(accounts.Config{Pool: pool, Customers: f.profs, Logger: quiet}); err != nil {
		t.Fatal(err)
	}
	src := &fakeSource{snap: snapshot("open_er_api", "1600", "0.8", "0.9")}
	if f.svc, err = NewService(Config{
		Pool: pool, Accounts: f.accts, Customers: f.profs, Limits: limitRules{}, Sources: []RatesSource{src},
		Logger: quiet, Now: f.clk.Now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.Ingest(t.Context()); err != nil {
		t.Fatal(err)
	}
	return f
}

type limitRules struct{}

func (limitRules) Rules() limits.Rules { return limits.DefaultRules() }

type customer struct {
	ctx    context.Context
	id     uuid.UUID
	ngn    uuid.UUID
	usd    uuid.UUID
	gbp    uuid.UUID
	wallet map[money.Currency]uuid.UUID
}

// customer signs up a Tier 2 customer with an NGN account and USD and GBP wallets.
func (f *fixture) customer(ngnKobo, usdCents int64) customer {
	f.t.Helper()
	ctx := f.t.Context()
	id := uuid.New()
	n := f.n.Add(1)
	if _, err := f.pool.Exec(ctx, `INSERT INTO users (id, first_name, last_name, email, phone, date_of_birth,
		password_hash, terms_version, privacy_version, consent_accepted_at)
		VALUES ($1, 'Test', 'Customer', $2, $3, '1996-04-12', 'x', '2026-10', '2026-10', now())`,
		id, fmt.Sprintf("fx%d@example.com", n), fmt.Sprintf("+2348032%06d", n)); err != nil {
		f.t.Fatal(err)
	}
	if err := pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		return accounts.OpenCurrentAccount(ctx, tx, identity.NewCustomer{UserID: id, Name: "Test Customer"})
	}); err != nil {
		f.t.Fatal(err)
	}
	f.profs.setTier(id, 2)
	c := customer{ctx: identity.WithPrincipal(ctx, identity.Principal{UserID: id}), id: id, wallet: map[money.Currency]uuid.UUID{}}
	for _, cur := range []money.Currency{money.USD, money.GBP} {
		v, err := f.accts.OpenWallet(c.ctx, cur)
		if err != nil {
			f.t.Fatal(err)
		}
		c.wallet[cur] = v.AccountID
	}
	list, err := f.accts.List(c.ctx)
	if err != nil {
		f.t.Fatal(err)
	}
	c.ngn, c.usd, c.gbp = list[0].AccountID, c.wallet[money.USD], c.wallet[money.GBP]
	f.fund(c.ngn, money.NGN, ngnKobo)
	f.fund(c.usd, money.USD, usdCents)
	return c
}

func (f *fixture) fund(account uuid.UUID, cur money.Currency, minor int64) {
	f.t.Helper()
	if minor == 0 {
		return
	}
	if err := pgx.BeginFunc(f.t.Context(), f.pool, func(tx pgx.Tx) error {
		src, err := ledger.SystemAccount(f.t.Context(), tx, ledger.KindDemoFunding, string(cur))
		if err != nil {
			return err
		}
		amt := money.New(minor, cur)
		_, err = ledger.Post(f.t.Context(), tx, ledger.Entry{Kind: "demo_funding", Reference: "seed",
			Legs: []ledger.Leg{ledger.Debit(src.ID, amt), ledger.Credit(account, amt)}})
		return err
	}); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) balance(account uuid.UUID) int64 {
	f.t.Helper()
	b, err := ledger.GetBalances(f.t.Context(), f.pool, account)
	if err != nil {
		f.t.Fatal(err)
	}
	return b.Ledger.Amount()
}

func (f *fixture) position(cur money.Currency) int64 {
	f.t.Helper()
	a, err := ledger.SystemAccount(f.t.Context(), f.pool, ledger.KindFXPosition, string(cur))
	if err != nil {
		f.t.Fatal(err)
	}
	return a.BalanceMinor
}

func usd(minor int64) *money.Money { m := money.New(minor, money.USD); return &m }
func ngn(minor int64) *money.Money { m := money.New(minor, money.NGN); return &m }

func wantProblem(t *testing.T, err error, code string) {
	t.Helper()
	var p *problem.Error
	if err == nil || !asProblem(err, &p) || p.Code != code {
		t.Fatalf("err = %v, want problem %q", err, code)
	}
}

func asProblem(err error, target **problem.Error) bool {
	for err != nil {
		if p, ok := err.(*problem.Error); ok { //nolint:errorlint // problem.Error has its own Is; this reads the code
			*target = p
			return true
		}
		u, ok := err.(interface{ Unwrap() error }) //nolint:errorlint // walking the chain by hand
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}

func TestQuoteLocksTheRateAndAmountsForSixtySeconds(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu := f.customer(0, 1_000_000)

	// Selling $100 at mid 1600 less 1.5% = 1576: exactly ₦157,600.00.
	q, err := f.svc.Quote(tolu.ctx, QuoteRequest{From: tolu.usd, To: tolu.ngn, Sell: usd(10_000)})
	if err != nil {
		t.Fatal(err)
	}
	if q.Sell != *usd(10_000) || q.Buy != *ngn(15_760_000) || q.Rate.String() != "1576" || q.Mid.String() != "1600" ||
		q.SpreadBPS != 150 || !q.Fee.IsZero() || q.Fee.Currency() != money.USD || !q.ExpiresAt.Equal(f.clk.Now().Add(60*time.Second)) {
		t.Fatalf("quote = %+v", q)
	}

	// Buying dollars costs the marked-up rate (1624), inverted to 0.00061576 dollars per naira.
	b, err := f.svc.Quote(tolu.ctx, QuoteRequest{From: tolu.ngn, To: tolu.usd, Sell: ngn(16_240_000)})
	if err != nil {
		t.Fatal(err)
	}
	if b.Rate.String() != "0.00061576" || b.Mid.String() != "0.000625" || b.Buy != *usd(9_999) {
		t.Fatalf("buy-side quote = %+v", b) // 8 decimal places cost the customer a cent here, never the bank
	}

	// Asking for a fixed number of dollars rounds the price up, so the customer gets at least that.
	fixed, err := f.svc.Quote(tolu.ctx, QuoteRequest{From: tolu.ngn, To: tolu.usd, Buy: usd(10_000)})
	if err != nil || fixed.Buy != *usd(10_000) || fixed.Sell != *ngn(16_240_094) {
		t.Fatalf("fixed buy = %+v, %v", fixed, err)
	}
}

func TestQuoteNeverFavoursTheCustomerByAMinorUnit(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu := f.customer(0, 0)
	for _, dir := range []struct{ from, to uuid.UUID }{{tolu.usd, tolu.ngn}, {tolu.ngn, tolu.usd}, {tolu.gbp, tolu.ngn}, {tolu.ngn, tolu.gbp}} {
		fromC, toC := f.currency(dir.from), f.currency(dir.to)
		for _, n := range []int64{1, 2, 3, 7, 99, 100, 101, 333, 1_000, 12_345, 987_654, 31_415_926} {
			// Selling n: the customer receives no more than n x rate.
			sell := money.New(n, fromC)
			q, err := f.svc.Quote(tolu.ctx, QuoteRequest{From: dir.from, To: dir.to, Sell: &sell})
			if err != nil {
				wantProblem(t, err, "validation_failed") // too small to buy even one minor unit
				continue
			}
			if lhs, rhs := big.NewInt(q.Buy.Amount()), exactBuy(q); lhs.Cmp(rhs) > 0 {
				t.Errorf("%s->%s sell %d: buy %d exceeds the exact %s", fromC, toC, n, q.Buy.Amount(), rhs)
			}
			// Buying n: the customer pays at least n / rate, and one minor unit less would not do.
			buy := money.New(n, toC)
			q, err = f.svc.Quote(tolu.ctx, QuoteRequest{From: dir.from, To: dir.to, Buy: &buy})
			if err != nil {
				t.Fatalf("%s->%s buy %d: %v", fromC, toC, n, err)
			}
			if got := Rate(q.Rate).applyExact(q.Sell.Amount()); got.Cmp(big.NewInt(n)) < 0 {
				t.Errorf("%s->%s buy %d: selling %d yields only %s", fromC, toC, n, q.Sell.Amount(), got)
			}
			if less := Rate(q.Rate).applyExact(q.Sell.Amount() - 1); q.Sell.Amount() > 1 && less.Cmp(big.NewInt(n)) >= 0 {
				t.Errorf("%s->%s buy %d: %d minor units would have been enough", fromC, toC, n, q.Sell.Amount()-1)
			}
		}
	}
}

// applyExact is amount x rate in minor units, floored: the reference the quote is judged against.
func (r Rate) applyExact(amount int64) *big.Int {
	n := new(big.Int).Mul(big.NewInt(amount), big.NewInt(int64(r)))
	return n.Quo(n, big.NewInt(rateScale))
}

func exactBuy(q QuoteView) *big.Int { return q.Rate.applyExact(q.Sell.Amount()) }

func (f *fixture) currency(account uuid.UUID) money.Currency {
	f.t.Helper()
	var c string
	if err := f.pool.QueryRow(f.t.Context(), `SELECT currency FROM ledger_accounts WHERE id = $1`, account).Scan(&c); err != nil {
		f.t.Fatal(err)
	}
	return money.Currency(c)
}

func TestQuoteRefusesWhatCannotBeConverted(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu := f.customer(0, 0)
	other := f.customer(0, 0)

	for name, tc := range map[string]struct {
		req  QuoteRequest
		code string
	}{
		"same account":      {QuoteRequest{From: tolu.usd, To: tolu.usd, Sell: usd(100)}, "validation_failed"},
		"wallet to wallet":  {QuoteRequest{From: tolu.usd, To: tolu.gbp, Sell: usd(100)}, "validation_failed"},
		"neither amount":    {QuoteRequest{From: tolu.usd, To: tolu.ngn}, "validation_failed"},
		"both amounts":      {QuoteRequest{From: tolu.usd, To: tolu.ngn, Sell: usd(100), Buy: ngn(100)}, "validation_failed"},
		"wrong currency":    {QuoteRequest{From: tolu.usd, To: tolu.ngn, Sell: ngn(100)}, "validation_failed"},
		"zero":              {QuoteRequest{From: tolu.usd, To: tolu.ngn, Sell: usd(0)}, "validation_failed"},
		"too small":         {QuoteRequest{From: tolu.ngn, To: tolu.usd, Sell: ngn(1)}, "validation_failed"},
		"too large":         {QuoteRequest{From: tolu.usd, To: tolu.ngn, Sell: usd(9_000_000_000_000_000_000)}, "validation_failed"},
		"not their account": {QuoteRequest{From: other.usd, To: tolu.ngn, Sell: usd(100)}, "not_found"},
	} {
		_, err := f.svc.Quote(tolu.ctx, tc.req)
		if err == nil {
			t.Errorf("%s: accepted", name)
			continue
		}
		var p *problem.Error
		if !asProblem(err, &p) || p.Code != tc.code {
			t.Errorf("%s: %v, want %s", name, err, tc.code)
		}
	}
	if _, err := f.svc.Quote(t.Context(), QuoteRequest{From: tolu.usd, To: tolu.ngn, Sell: usd(100)}); err == nil {
		t.Error("an unauthenticated quote was made")
	}

	if _, err := f.pool.Exec(t.Context(), `UPDATE customer_accounts SET status = 'frozen' WHERE account_id = $1`, tolu.usd); err != nil {
		t.Fatal(err)
	}
	_, err := f.svc.Quote(tolu.ctx, QuoteRequest{From: tolu.usd, To: tolu.ngn, Sell: usd(100)})
	wantProblem(t, err, "account_not_active")
}

func TestQuotesStopWhenTheRatesAreTooOld(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu := f.customer(0, 100_000)
	req := QuoteRequest{From: tolu.usd, To: tolu.ngn, Sell: usd(100)}
	f.clk.advance(23 * time.Hour) // stale for the app (cache) but still tradeable
	if _, err := f.svc.Quote(tolu.ctx, req); err != nil {
		t.Fatal(err)
	}
	f.clk.advance(2 * time.Hour)
	_, err := f.svc.Quote(tolu.ctx, req)
	wantProblem(t, err, "rates_unavailable")
}

func TestAConversionMovesBothBalancesThroughTheFXPositionsOnce(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu := f.customer(1_000_000, 50_000) // ₦10,000.00 and $500.00
	ctx := tolu.ctx

	q, err := f.svc.Quote(ctx, QuoteRequest{From: tolu.usd, To: tolu.ngn, Sell: usd(10_000)})
	if err != nil {
		t.Fatal(err)
	}
	c, err := f.svc.Convert(ctx, q.ID)
	if err != nil {
		t.Fatal(err)
	}
	if c.QuoteID != q.ID || c.Sell != q.Sell || c.Buy != q.Buy || c.Rate != q.Rate || c.Status != "completed" ||
		c.DebitTransaction == c.CreditTransaction || !c.CreatedAt.Equal(f.clk.Now()) {
		t.Fatalf("conversion = %+v", c)
	}
	if f.balance(tolu.usd) != 40_000 || f.balance(tolu.ngn) != 1_000_000+15_760_000 {
		t.Fatalf("balances: usd %d, ngn %d", f.balance(tolu.usd), f.balance(tolu.ngn))
	}
	// The bank took the customer's dollars and paid out naira: long dollars, short naira.
	if f.position(money.USD) != 10_000 || f.position(money.NGN) != -15_760_000 {
		t.Fatalf("positions: usd %d, ngn %d", f.position(money.USD), f.position(money.NGN))
	}
	if drift, err := ledger.Drift(ctx, f.pool); err != nil || len(drift) != 0 {
		t.Fatalf("ledger drift = %+v, %v", drift, err)
	}

	// Both statement lines exist, point at the entry, and carry the running balance.
	var debit, credit struct {
		typ, dir, status string
		amount, fee      int64
		after            *int64
		account          uuid.UUID
	}
	row := func(id uuid.UUID) (r struct {
		typ, dir, status string
		amount, fee      int64
		after            *int64
		account          uuid.UUID
	}) {
		if err := f.pool.QueryRow(ctx, `SELECT type, direction, status, amount_minor, coalesce(fee_minor, 0), balance_after_minor, account_id
			FROM transactions WHERE id = $1`, id).Scan(&r.typ, &r.dir, &r.status, &r.amount, &r.fee, &r.after, &r.account); err != nil {
			t.Fatal(err)
		}
		return r
	}
	debit, credit = row(c.DebitTransaction), row(c.CreditTransaction)
	if debit.typ != "fx_conversion" || debit.dir != "debit" || debit.amount != 10_000 || debit.account != tolu.usd || debit.after == nil || *debit.after != 40_000 ||
		credit.typ != "fx_conversion" || credit.dir != "credit" || credit.amount != 15_760_000 || credit.account != tolu.ngn || credit.after == nil || *credit.after != 16_760_000 {
		t.Fatalf("lines: debit %+v, credit %+v", debit, credit)
	}

	// The quote is spent: replaying it, even under a new request, moves nothing.
	_, err = f.svc.Convert(ctx, q.ID)
	wantProblem(t, err, "quote_used")
	if f.balance(tolu.usd) != 40_000 || f.balance(tolu.ngn) != 16_760_000 {
		t.Fatalf("a replay moved money: usd %d, ngn %d", f.balance(tolu.usd), f.balance(tolu.ngn))
	}
}

func TestAQuoteExpiresAfterSixtySecondsAndBelongsToItsOwner(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu := f.customer(0, 50_000)
	ada := f.customer(0, 50_000)

	q, err := f.svc.Quote(tolu.ctx, QuoteRequest{From: tolu.usd, To: tolu.ngn, Sell: usd(10_000)})
	if err != nil {
		t.Fatal(err)
	}
	// Someone else's quote looks like no quote at all.
	_, err = f.svc.Convert(ada.ctx, q.ID)
	wantProblem(t, err, "not_found")
	_, err = f.svc.Convert(tolu.ctx, uuid.New())
	wantProblem(t, err, "not_found")

	f.clk.advance(59 * time.Second)
	if _, err := f.svc.Convert(tolu.ctx, q.ID); err != nil {
		t.Fatalf("at 59 s: %v", err)
	}

	late, err := f.svc.Quote(tolu.ctx, QuoteRequest{From: tolu.usd, To: tolu.ngn, Sell: usd(10_000)})
	if err != nil {
		t.Fatal(err)
	}
	f.clk.advance(60 * time.Second) // the instant it expires is already too late
	_, err = f.svc.Convert(tolu.ctx, late.ID)
	wantProblem(t, err, "quote_expired")
	if f.balance(tolu.usd) != 40_000 {
		t.Fatalf("an expired quote moved money: usd %d", f.balance(tolu.usd))
	}
}

func TestAConversionWithoutFundsChangesNothingAndTheQuoteSurvives(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu := f.customer(0, 5_000) // $50
	q, err := f.svc.Quote(tolu.ctx, QuoteRequest{From: tolu.usd, To: tolu.ngn, Sell: usd(10_000)})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.svc.Convert(tolu.ctx, q.ID)
	wantProblem(t, err, "insufficient_funds")

	var lines, conversions, entries int
	if err := f.pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM transactions WHERE type = 'fx_conversion'),
		(SELECT count(*) FROM fx_conversions), (SELECT count(*) FROM journal_entries WHERE kind = 'fx_conversion')`).Scan(&lines, &conversions, &entries); err != nil {
		t.Fatal(err)
	}
	if lines != 0 || conversions != 0 || entries != 0 || f.balance(tolu.usd) != 5_000 || f.position(money.USD) != 0 {
		t.Fatalf("a failed conversion left traces: %d lines, %d conversions, %d entries", lines, conversions, entries)
	}

	// Top up inside the 60 seconds and the same quote still works.
	f.fund(tolu.usd, money.USD, 10_000)
	if _, err := f.svc.Convert(tolu.ctx, q.ID); err != nil {
		t.Fatalf("after topping up: %v", err)
	}
}

func TestTwoRequestsForOneQuoteConvertOnce(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu := f.customer(0, 100_000)
	q, err := f.svc.Quote(tolu.ctx, QuoteRequest{From: tolu.usd, To: tolu.ngn, Sell: usd(10_000)})
	if err != nil {
		t.Fatal(err)
	}
	const racers = 6
	var wg sync.WaitGroup
	var won, used atomic.Int32
	for range racers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := f.svc.Convert(tolu.ctx, q.ID)
			var p *problem.Error
			switch {
			case err == nil:
				won.Add(1)
			case asProblem(err, &p) && p.Code == "quote_used":
				used.Add(1)
			default:
				t.Errorf("unexpected: %v", err)
			}
		}()
	}
	wg.Wait()
	if won.Load() != 1 || used.Load() != racers-1 || f.balance(tolu.usd) != 90_000 {
		t.Fatalf("won %d, used %d, usd balance %d", won.Load(), used.Load(), f.balance(tolu.usd))
	}
}

func TestConvertedNairaStaysUnderTheKYCBalanceCap(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu := f.customer(0, 1_000_000)
	f.profs.setTier(tolu.id, 1) // a Tier 1 balance is capped at ₦300,000 = 30,000,000 kobo

	q, err := f.svc.Quote(tolu.ctx, QuoteRequest{From: tolu.usd, To: tolu.ngn, Sell: usd(200_000)}) // $2,000 = ₦3,152,000
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.svc.Convert(tolu.ctx, q.ID)
	wantProblem(t, err, "max_balance_exceeded")
	if f.balance(tolu.usd) != 1_000_000 || f.balance(tolu.ngn) != 0 {
		t.Fatalf("the refused conversion moved money: usd %d, ngn %d", f.balance(tolu.usd), f.balance(tolu.ngn))
	}
	small, _ := f.svc.Quote(tolu.ctx, QuoteRequest{From: tolu.usd, To: tolu.ngn, Sell: usd(10_000)})
	if _, err := f.svc.Convert(tolu.ctx, small.ID); err != nil {
		t.Fatalf("a conversion under the cap: %v", err)
	}
}

func TestConversionHistoryIsNewestFirstAndPaged(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu := f.customer(0, 1_000_000)
	ada := f.customer(0, 1_000_000)
	var ids []uuid.UUID
	for i := range 3 {
		q, err := f.svc.Quote(tolu.ctx, QuoteRequest{From: tolu.usd, To: tolu.ngn, Sell: usd(int64(1_000 * (i + 1)))})
		if err != nil {
			t.Fatal(err)
		}
		c, err := f.svc.Convert(tolu.ctx, q.ID)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, c.ID)
		f.clk.advance(time.Minute)
	}
	if q, err := f.svc.Quote(ada.ctx, QuoteRequest{From: ada.usd, To: ada.ngn, Sell: usd(1_000)}); err == nil {
		_, _ = f.svc.Convert(ada.ctx, q.ID)
	}

	page, info, err := f.svc.Conversions(tolu.ctx, nil, new(2))
	if err != nil || len(page) != 2 || page[0].ID != ids[2] || page[1].ID != ids[1] || info.NextCursor == nil {
		t.Fatalf("first page = %+v, %+v, %v", page, info, err)
	}
	rest, info, err := f.svc.Conversions(tolu.ctx, info.NextCursor, new(2))
	if err != nil || len(rest) != 1 || rest[0].ID != ids[0] || info.NextCursor != nil || rest[0].Sell != *usd(1_000) {
		t.Fatalf("second page = %+v, %+v, %v", rest, info, err)
	}
	if _, _, err := f.svc.Conversions(tolu.ctx, new("garbage"), nil); err == nil {
		t.Fatal("a forged cursor was accepted")
	}
}

func TestPruneKeepsUsedQuotesAndDropsOldUnusedOnes(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu := f.customer(0, 100_000)
	used, _ := f.svc.Quote(tolu.ctx, QuoteRequest{From: tolu.usd, To: tolu.ngn, Sell: usd(1_000)})
	if _, err := f.svc.Convert(tolu.ctx, used.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Quote(tolu.ctx, QuoteRequest{From: tolu.usd, To: tolu.ngn, Sell: usd(1_000)}); err != nil {
		t.Fatal(err)
	}
	f.clk.advance(26 * time.Hour)
	if err := f.svc.Prune(t.Context()); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM fx_quotes`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("quotes after prune = %d, %v", n, err)
	}
	if c, _, err := f.svc.Conversions(tolu.ctx, nil, nil); err != nil || len(c) != 1 {
		t.Fatalf("history after prune = %+v, %v", c, err)
	}
}
