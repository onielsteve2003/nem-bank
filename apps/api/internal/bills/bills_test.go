package bills

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
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/limits"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

// profiles is every customer's KYC tier (Tier 2: ₦200k a day) with no cool-off.
type profiles struct{ tier int }

func (p profiles) CustomerProfile(context.Context, uuid.UUID) (identity.CustomerProfile, error) {
	return identity.CustomerProfile{Name: "Tolu Adeyemi", KycTier: p.tier}, nil
}
func (profiles) CoolOff(context.Context) (identity.CoolOff, error) { return identity.CoolOff{}, nil }

// flaky wraps the simulated biller so a test can make it unreachable, and counts vends.
type flaky struct {
	Simulated
	down  atomic.Bool
	vends atomic.Int64
}

var errDown = errors.New("biller: connection refused")

func (f *flaky) Vend(ctx context.Context, r VendRequest) (VendResult, error) {
	f.vends.Add(1)
	if f.down.Load() {
		return VendResult{}, errDown
	}
	return f.Simulated.Vend(ctx, r)
}

type fixture struct {
	t      *testing.T
	pool   *pgxpool.Pool
	svc    *Service
	biller *flaky
	clk    *clock
	n      atomic.Int64
}

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

func newFixture(t *testing.T) *fixture {
	t.Helper()
	pool := testdb.New(t)
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	f := &fixture{t: t, pool: pool, biller: &flaky{}, clk: &clock{t: time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)}}
	prof := profiles{tier: 2}
	accts, err := accounts.NewService(accounts.Config{Pool: pool, Customers: prof, Logger: quiet})
	if err != nil {
		t.Fatal(err)
	}
	lim, err := limits.NewService(limits.Config{Pool: pool, Customers: prof, Now: f.clk.Now})
	if err != nil {
		t.Fatal(err)
	}
	if f.svc, err = NewService(Config{Pool: pool, Accounts: accts, Customers: prof, Limits: lim, Biller: f.biller, Logger: quiet, Now: f.clk.Now}); err != nil {
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
		id, fmt.Sprintf("bill%d@example.com", n), fmt.Sprintf("+2348044%06d", n)); err != nil {
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
		if err := pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
			src, err := ledger.SystemAccount(ctx, tx, ledger.KindDemoFunding, "NGN")
			if err != nil {
				return err
			}
			amt := money.New(ngnKobo, money.NGN)
			_, err = ledger.Post(ctx, tx, ledger.Entry{Kind: "demo_funding", Reference: "seed",
				Legs: []ledger.Leg{ledger.Debit(src.ID, amt), ledger.Credit(c.ngn, amt)}})
			return err
		}); err != nil {
			f.t.Fatal(err)
		}
	}
	return c
}

func (f *fixture) balance(account uuid.UUID) int64 {
	f.t.Helper()
	var bal int64
	if err := f.pool.QueryRow(f.t.Context(), `SELECT balance_minor FROM ledger_accounts WHERE id = $1`, account).Scan(&bal); err != nil {
		f.t.Fatal(err)
	}
	return bal
}

func (f *fixture) usedToday(c customer) int64 {
	f.t.Helper()
	var used int64
	err := f.pool.QueryRow(f.t.Context(), `SELECT coalesce(sum(used_minor), 0) FROM daily_limit_usage WHERE user_id = $1`, c.id).Scan(&used)
	if err != nil {
		f.t.Fatal(err)
	}
	return used
}

func wantProblem(t *testing.T, err error, code string) {
	t.Helper()
	var p *problem.Error
	if err == nil || !errors.As(err, &p) || p.Code != code {
		t.Fatalf("err = %v, want problem %q", err, code)
	}
}

func TestPayingAirtimeDebitsOnceAndWritesTheHistoryLine(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00)
	p, err := f.svc.Pay(c.ctx, PayRequest{BillerID: "mtn-airtime", CustomerID: "0803 123 4567", Amount: naira(500), Source: c.ngn})
	if err != nil {
		t.Fatal(err)
	}
	if p.Status != "completed" || p.CustomerID != "+2348031234567" || p.Token != nil || p.TransactionID == nil || p.Fee.Amount() != 0 {
		t.Fatalf("payment = %+v", p)
	}
	if got := f.balance(c.ngn); got != 9_500_00 {
		t.Fatalf("balance = %d, want 950000", got)
	}
	var typ, dir, status, category string
	var amount int64
	if err := f.pool.QueryRow(t.Context(), `SELECT type, direction, status, category, amount_minor FROM transactions WHERE id = $1`, *p.TransactionID).
		Scan(&typ, &dir, &status, &category, &amount); err != nil {
		t.Fatal(err)
	}
	if typ != "bill_payment" || dir != "debit" || status != "completed" || category != "airtime_data" || amount != 500_00 {
		t.Fatalf("line = %s %s %s %s %d", typ, dir, status, category, amount)
	}
	if used := f.usedToday(c); used != 500_00 {
		t.Fatalf("daily usage = %d, want 50000", used)
	}
	got, err := f.svc.Get(c.ctx, p.ID)
	if err != nil || got.ID != p.ID || got.Status != "completed" {
		t.Fatalf("get = %+v, %v", got, err)
	}
}

func TestElectricityNeedsAValidMeterAndReturnsAToken(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00)
	_, err := f.svc.Pay(c.ctx, PayRequest{BillerID: "ikeja-electric-prepaid", CustomerID: "12340000000", Amount: naira(2_000), Source: c.ngn})
	wantProblem(t, err, "customer_not_found")
	if f.balance(c.ngn) != 10_000_00 {
		t.Fatal("a refused meter cost the customer money")
	}
	p, err := f.svc.Pay(c.ctx, PayRequest{BillerID: "ikeja-electric-prepaid", CustomerID: "12345678901", Amount: naira(4_500), Source: c.ngn})
	if err != nil || p.Status != "completed" || p.Token == nil || p.Units == nil || *p.Units != "20.0 kWh" {
		t.Fatalf("payment = %+v, %v", p, err)
	}
	if f.vends(t) != 1 {
		t.Fatalf("vends = %d", f.biller.vends.Load())
	}
}

func (f *fixture) vends(t *testing.T) int64 { t.Helper(); return f.biller.vends.Load() }

func TestAPlanMustBePickedAndPricedAsListed(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(100_000_00)
	base := PayRequest{BillerID: "mtn-data", CustomerID: "08031234567", Source: c.ngn}
	for name, tc := range map[string]struct {
		product string
		amount  money.Money
	}{
		"no plan":      {"", naira(1_000)},
		"unknown plan": {"99gb", naira(1_000)},
		"wrong price":  {"2gb-7d", naira(900)},
	} {
		r := base
		r.ProductID, r.Amount = tc.product, tc.amount
		if _, err := f.svc.Pay(c.ctx, r); err == nil {
			t.Errorf("%s: expected a refusal", name)
		}
	}
	r := base
	r.ProductID, r.Amount = "2gb-7d", naira(1_000)
	p, err := f.svc.Pay(c.ctx, r)
	if err != nil || p.ProductName == nil || *p.ProductName != "2GB, 7 days" {
		t.Fatalf("payment = %+v, %v", p, err)
	}
	if f.balance(c.ngn) != 99_000_00 {
		t.Fatalf("balance = %d", f.balance(c.ngn))
	}
}

func TestAmountAndAccountRules(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(100_000_00)
	pay := func(r PayRequest) error {
		r.Source = c.ngn
		_, err := f.svc.Pay(c.ctx, r)
		return err
	}
	wantProblem(t, pay(PayRequest{BillerID: "mtn-airtime", CustomerID: "08031234567", Amount: naira(20)}), problem.CodeValidationFailed)                    // below the ₦50 minimum
	wantProblem(t, pay(PayRequest{BillerID: "mtn-airtime", CustomerID: "08031234567", Amount: naira(60_000)}), problem.CodeValidationFailed)                // above the airtime maximum
	wantProblem(t, pay(PayRequest{BillerID: "mtn-airtime", CustomerID: "12345", Amount: naira(100)}), problem.CodeValidationFailed)                         // not a phone number
	wantProblem(t, pay(PayRequest{BillerID: "mtn-airtime", CustomerID: "08031234567", Amount: money.New(100_00, money.USD)}), problem.CodeValidationFailed) // wrong currency
	if err := pay(PayRequest{BillerID: "nope", CustomerID: "08031234567", Amount: naira(100)}); !errors.Is(err, ErrBillerNotFound) {
		t.Fatalf("unknown biller err = %v", err)
	}
	// Someone else's account is a 404, not a debit.
	other := f.customer(100_000_00)
	_, err := f.svc.Pay(c.ctx, PayRequest{BillerID: "mtn-airtime", CustomerID: "08031234567", Amount: naira(100), Source: other.ngn})
	if err == nil || f.balance(other.ngn) != 100_000_00 {
		t.Fatalf("paying from another customer's account: err = %v", err)
	}
	if f.vends(t) != 0 {
		t.Fatal("a refused request still reached the biller")
	}
}

func TestInsufficientFundsChargesNothingAndSkipsTheBiller(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(300_00)
	_, err := f.svc.Pay(c.ctx, PayRequest{BillerID: "mtn-airtime", CustomerID: "08031234567", Amount: naira(500), Source: c.ngn})
	wantProblem(t, err, "insufficient_funds")
	if f.balance(c.ngn) != 300_00 || f.usedToday(c) != 0 || f.vends(t) != 0 {
		t.Fatalf("balance %d, used %d, vends %d", f.balance(c.ngn), f.usedToday(c), f.vends(t))
	}
}

func TestARefusingBillerGivesTheMoneyAndTheLimitBack(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00)
	p, err := f.svc.Pay(c.ctx, PayRequest{BillerID: "mtn-airtime", CustomerID: "08031239999", Amount: naira(500), Source: c.ngn})
	if err != nil {
		t.Fatal(err)
	}
	if p.Status != "reversed" || p.Token != nil {
		t.Fatalf("payment = %+v", p)
	}
	if f.balance(c.ngn) != 10_000_00 {
		t.Fatalf("balance = %d, want the full 1000000 back", f.balance(c.ngn))
	}
	if f.usedToday(c) != 0 {
		t.Fatalf("daily usage = %d, want the reversed amount released", f.usedToday(c))
	}
	var lines int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM transactions WHERE user_id = $1 AND reference = $2`, c.id, p.Reference).Scan(&lines); err != nil || lines != 2 {
		t.Fatalf("history lines = %d (%v), want the debit and its reversal", lines, err)
	}
	// Settlement nets to zero: what came in went back out.
	var settle int64
	if err := f.pool.QueryRow(t.Context(), `SELECT balance_minor FROM ledger_accounts WHERE kind = 'partner_settlement' AND currency = 'NGN'`).Scan(&settle); err != nil || settle != 0 {
		t.Fatalf("partner settlement = %d (%v)", settle, err)
	}
}

func TestAnUnreachableBillerLeavesThePaymentForTheSweep(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00)
	f.biller.down.Store(true)
	p, err := f.svc.Pay(c.ctx, PayRequest{BillerID: "eko-electric-prepaid", CustomerID: "12345678901", Amount: naira(2_000), Source: c.ngn})
	if err != nil || p.Status != "processing" || p.Token != nil {
		t.Fatalf("payment = %+v, %v", p, err)
	}
	// Not reversed on a guess: the money stays with the bank while the answer is unknown.
	if f.balance(c.ngn) != 8_000_00 {
		t.Fatalf("balance = %d", f.balance(c.ngn))
	}
	// Too soon: a request may still be waiting on the biller.
	if n, err := f.svc.SweepStuck(t.Context()); err != nil || n != 0 || f.vends(t) != 1 {
		t.Fatalf("early sweep = %d, %v, vends %d", n, err, f.vends(t))
	}
	f.clk.advance(stuckAfter + time.Minute)
	if n, err := f.svc.SweepStuck(t.Context()); err != nil || n != 0 {
		t.Fatalf("sweep while down = %d, %v", n, err)
	}
	f.biller.down.Store(false)
	n, err := f.svc.SweepStuck(t.Context())
	if err != nil || n != 1 {
		t.Fatalf("sweep = %d, %v", n, err)
	}
	got, err := f.svc.Get(c.ctx, p.ID)
	if err != nil || got.Status != "completed" || got.Token == nil {
		t.Fatalf("after sweep = %+v, %v", got, err)
	}
	if f.balance(c.ngn) != 8_000_00 {
		t.Fatalf("balance changed on completion: %d", f.balance(c.ngn))
	}
	if n, _ := f.svc.SweepStuck(t.Context()); n != 0 {
		t.Fatalf("a finished payment was swept again (%d)", n)
	}
}

func TestSettlingTwiceRefundsOnce(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00)
	f.biller.down.Store(true)
	p, err := f.svc.Pay(c.ctx, PayRequest{BillerID: "mtn-airtime", CustomerID: "08031234567", Amount: naira(500), Source: c.ngn})
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for range 5 {
		wg.Go(func() {
			if _, err := f.svc.settle(t.Context(), p.ID, nil, "biller_rejected"); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if f.balance(c.ngn) != 10_000_00 || f.usedToday(c) != 0 {
		t.Fatalf("balance %d, used %d: refunded more than once or not at all", f.balance(c.ngn), f.usedToday(c))
	}
}

func TestDailyLimitCountsBillsLikeTransfers(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(1_000_000_00)
	// Tier 2's daily cap is ₦200,000: four ₦50,000 airtime top-ups fit, the fifth does not.
	for i := range 4 {
		if _, err := f.svc.Pay(c.ctx, PayRequest{BillerID: "mtn-airtime", CustomerID: "08031234567", Amount: naira(50_000), Source: c.ngn}); err != nil {
			t.Fatalf("payment %d: %v", i+1, err)
		}
	}
	_, err := f.svc.Pay(c.ctx, PayRequest{BillerID: "mtn-airtime", CustomerID: "08031234567", Amount: naira(50_000), Source: c.ngn})
	wantProblem(t, err, limits.CodeLimitExceeded)
}

func TestPaymentsListNewestFirstAndOnlyTheOwners(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(100_000_00)
	other := f.customer(100_000_00)
	var ids []uuid.UUID
	for range 3 {
		p, err := f.svc.Pay(c.ctx, PayRequest{BillerID: "glo-airtime", CustomerID: "08051234567", Amount: naira(100), Source: c.ngn})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, p.ID)
		f.clk.advance(time.Second)
	}
	theirs, err := f.svc.Pay(other.ctx, PayRequest{BillerID: "glo-airtime", CustomerID: "08051234567", Amount: naira(100), Source: other.ngn})
	if err != nil {
		t.Fatal(err)
	}
	two := 2
	page1, info, err := f.svc.List(c.ctx, nil, &two)
	if err != nil || len(page1) != 2 || info.NextCursor == nil || page1[0].ID != ids[2] || page1[1].ID != ids[1] {
		t.Fatalf("page 1 = %+v %+v %v", page1, info, err)
	}
	page2, info, err := f.svc.List(c.ctx, info.NextCursor, &two)
	if err != nil || len(page2) != 1 || info.NextCursor != nil || page2[0].ID != ids[0] {
		t.Fatalf("page 2 = %+v %+v %v", page2, info, err)
	}
	if _, err := f.svc.Get(c.ctx, theirs.ID); !errors.Is(err, ErrPaymentNotFound) {
		t.Fatalf("reading another customer's payment: %v", err)
	}
}

func TestAPIShapes(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	a := NewAPI(f.svc)
	c := f.customer(10_000_00)

	cat := api.Data
	resp, err := a.ListBillers(c.ctx, api.ListBillersRequestObject{Params: api.ListBillersParams{Category: &cat}})
	if err != nil {
		t.Fatal(err)
	}
	billers := resp.(api.ListBillers200JSONResponse).Data
	if len(billers) != 4 || !billers[0].HasProducts || billers[0].Network == nil || billers[0].MinAmount != nil {
		t.Fatalf("data billers = %+v", billers)
	}

	det, err := a.DetectNetwork(c.ctx, api.DetectNetworkRequestObject{Body: &api.DetectNetworkJSONRequestBody{Phone: "+2348021234567"}})
	if err != nil || *det.(api.DetectNetwork200JSONResponse).Network != api.MobileNetwork("airtel") {
		t.Fatalf("detect = %+v, %v", det, err)
	}

	product := "2gb-7d"
	pay, err := a.PayBill(c.ctx, api.PayBillRequestObject{Body: &api.PayBillJSONRequestBody{
		BillerId: "mtn-data", ProductId: &product, CustomerId: "08031234567", SourceAccountId: c.ngn,
		Amount: api.Money{AmountMinor: "100000", Currency: "NGN"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	got := api.BillPayment(pay.(api.PayBill201JSONResponse))
	if got.Status != api.BillPaymentStatusCompleted || got.Category != api.Data || got.Amount.AmountMinor != "100000" || got.Fee.AmountMinor != "0" || got.Token != nil {
		t.Fatalf("payment = %+v", got)
	}
}
