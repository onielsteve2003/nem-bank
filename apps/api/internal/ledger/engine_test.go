package ledger

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

func ngn(minor int64) money.Money { return money.New(minor, money.NGN) }

// postTx runs Post in its own transaction.
func (d *db) postTx(e Entry) (Posted, error) {
	d.t.Helper()
	var out Posted
	err := pgx.BeginFunc(d.t.Context(), d.pool, func(tx pgx.Tx) error {
		var err error
		out, err = Post(d.t.Context(), tx, e)
		return err
	})
	return out, err
}

// fund gives account minor of demo money.
func (d *db) fund(account uuid.UUID, minor int64) {
	d.t.Helper()
	if _, err := d.postTx(Entry{Kind: "demo_funding", Reference: "test", Legs: []Leg{
		Debit(d.system(KindDemoFunding, "NGN"), ngn(minor)), Credit(account, ngn(minor)),
	}}); err != nil {
		d.t.Fatalf("fund: %v", err)
	}
}

func (d *db) balances(account uuid.UUID) (ledgerBal, available int64) {
	d.t.Helper()
	b, err := GetBalances(d.t.Context(), d.pool, account)
	if err != nil {
		d.t.Fatal(err)
	}
	return b.Ledger.Amount(), b.Available.Amount()
}

func (d *db) wantBalances(account uuid.UUID, ledgerBal, available int64) {
	d.t.Helper()
	if l, a := d.balances(account); l != ledgerBal || a != available {
		d.t.Fatalf("balances = %d / %d, want %d / %d", l, a, ledgerBal, available)
	}
}

func (d *db) wantNoDrift() {
	d.t.Helper()
	rows, err := Drift(d.t.Context(), d.pool)
	if err != nil {
		d.t.Fatal(err)
	}
	if len(rows) > 0 {
		d.t.Fatalf("cached balances drifted from the postings: %+v", rows)
	}
}

func TestPostMovesMoneyAndRecordsRunningBalances(t *testing.T) {
	t.Parallel()
	d := newDB(t)
	tolu, ada := d.customer("NGN"), d.customer("NGN")
	fees := d.system(KindFeeIncome, "NGN")
	d.fund(tolu, 500_000)

	posted, err := d.postTx(Entry{Kind: "transfer_internal", Reference: "trf_1", Legs: []Leg{
		Debit(tolu, ngn(100_000)), Credit(ada, ngn(100_000)),
		Debit(tolu, ngn(1_000)), Credit(fees, ngn(1_000)),
	}})
	if err != nil {
		t.Fatal(err)
	}
	// The second debit on Tolu's account sees the first: balances run within the entry.
	wantAfter := []int64{400_000, 100_000, 399_000, 1_000}
	for i, p := range posted.Postings {
		if p.BalanceAfterMinor != wantAfter[i] {
			t.Fatalf("posting %d balance_after = %d, want %d", i, p.BalanceAfterMinor, wantAfter[i])
		}
	}
	d.wantBalances(tolu, 399_000, 399_000)
	d.wantBalances(ada, 100_000, 100_000)
	d.wantNoDrift()
}

func TestPostRefusesOverdraftsAndWritesNothing(t *testing.T) {
	t.Parallel()
	d := newDB(t)
	tolu, ada := d.customer("NGN"), d.customer("NGN")
	d.fund(tolu, 10_000)
	_, err := d.postTx(Entry{Kind: "transfer_internal", Reference: "trf", Legs: []Leg{Debit(tolu, ngn(10_001)), Credit(ada, ngn(10_001))}})
	if !errors.Is(err, ErrInsufficientFunds) {
		t.Fatalf("err = %v, want insufficient funds", err)
	}
	d.wantBalances(tolu, 10_000, 10_000)
	d.wantBalances(ada, 0, 0)
	// The bank's own accounts may go negative: demo funding is the source of demo money.
	if l, _ := d.balances(d.system(KindDemoFunding, "NGN")); l != -10_000 {
		t.Fatalf("demo funding = %d, want -10000", l)
	}
}

func TestPostRefusesImpossibleEntriesBeforeLocking(t *testing.T) {
	t.Parallel()
	d := newDB(t)
	tolu, usd := d.customer("NGN"), d.customer("USD")
	funding := d.system(KindDemoFunding, "NGN")
	for name, tc := range map[string]struct {
		legs []Leg
		want error
	}{
		"one leg":        {[]Leg{Credit(tolu, ngn(1))}, ErrTooFewLegs},
		"zero leg":       {[]Leg{Credit(tolu, ngn(0)), Debit(funding, ngn(0))}, ErrTooFewLegs},
		"unbalanced":     {[]Leg{Credit(tolu, ngn(2)), Debit(funding, ngn(1))}, ErrUnbalanced},
		"wrong currency": {[]Leg{Credit(usd, ngn(1)), Debit(funding, ngn(1))}, ErrWrongCurrency},
		"unknown":        {[]Leg{Credit(uuid.Must(uuid.NewV7()), ngn(1)), Debit(funding, ngn(1))}, ErrUnknownAccount},
	} {
		if _, err := d.postTx(Entry{Kind: "demo_funding", Reference: "x", Legs: tc.legs}); !errors.Is(err, tc.want) {
			t.Errorf("%s: err = %v, want %v", name, err, tc.want)
		}
	}
}

func TestTheSameIdempotencyKeyPostsOnce(t *testing.T) {
	t.Parallel()
	d := newDB(t)
	tolu := d.customer("NGN")
	e := Entry{Kind: "demo_funding", Reference: "x", IdempotencyKey: "fund-1", Legs: []Leg{
		Debit(d.system(KindDemoFunding, "NGN"), ngn(5_000)), Credit(tolu, ngn(5_000)),
	}}
	if _, err := d.postTx(e); err != nil {
		t.Fatal(err)
	}
	// The duplicate leaves the transaction usable, so the caller can read the first entry.
	err := pgx.BeginFunc(t.Context(), d.pool, func(tx pgx.Tx) error {
		if _, err := Post(t.Context(), tx, e); !errors.Is(err, ErrDuplicateEntry) {
			t.Errorf("second post err = %v, want ErrDuplicateEntry", err)
		}
		_, err := tx.Exec(t.Context(), "SELECT 1")
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	d.wantBalances(tolu, 5_000, 5_000)
}

func TestHoldsReduceAvailableUntilReleasedOrCaptured(t *testing.T) {
	t.Parallel()
	d := newDB(t)
	ctx := t.Context()
	tolu := d.customer("NGN")
	partner := d.system(KindPartnerSettlement, "NGN")
	d.fund(tolu, 50_000)

	hold := func(minor int64) (uuid.UUID, error) {
		var id uuid.UUID
		err := pgx.BeginFunc(ctx, d.pool, func(tx pgx.Tx) error {
			h, err := PlaceHold(ctx, tx, tolu, ngn(minor), "trf_ext")
			id = h.ID
			return err
		})
		return id, err
	}
	release := func(id uuid.UUID) error {
		return pgx.BeginFunc(ctx, d.pool, func(tx pgx.Tx) error { return ReleaseHold(ctx, tx, id) })
	}

	h1, err := hold(30_000)
	if err != nil {
		t.Fatal(err)
	}
	d.wantBalances(tolu, 50_000, 20_000)
	if _, err := hold(20_001); !errors.Is(err, ErrInsufficientFunds) {
		t.Fatalf("hold over available: err = %v", err)
	}
	// Held money cannot be spent by another entry...
	if _, err := d.postTx(Entry{Kind: "transfer_external", Reference: "x", Legs: []Leg{Debit(tolu, ngn(25_000)), Credit(partner, ngn(25_000))}}); !errors.Is(err, ErrInsufficientFunds) {
		t.Fatalf("spending held money: err = %v", err)
	}
	// ...but the entry that captures the hold spends it.
	if _, err := d.postTx(Entry{Kind: "transfer_external", Reference: "x", Capture: []uuid.UUID{h1},
		Legs: []Leg{Debit(tolu, ngn(30_000)), Credit(partner, ngn(30_000))}}); err != nil {
		t.Fatalf("capture: %v", err)
	}
	d.wantBalances(tolu, 20_000, 20_000)
	if err := release(h1); !errors.Is(err, ErrHoldClosed) {
		t.Fatalf("releasing a captured hold: err = %v", err)
	}

	h2, err := hold(5_000)
	if err != nil {
		t.Fatal(err)
	}
	if err := release(h2); err != nil {
		t.Fatal(err)
	}
	if err := release(h2); !errors.Is(err, ErrHoldClosed) {
		t.Fatalf("double release: err = %v", err)
	}
	d.wantBalances(tolu, 20_000, 20_000)
	d.wantNoDrift()
}

// Opposite transfers between the same two accounts would deadlock if each locked its
// debit side first. The engine locks by ID, so they all finish.
func TestOppositeTransfersDoNotDeadlock(t *testing.T) {
	t.Parallel()
	d := newDB(t)
	a, b := d.customer("NGN"), d.customer("NGN")
	d.fund(a, 1_000_000)
	d.fund(b, 1_000_000)
	var wg sync.WaitGroup
	errs := make(chan error, 40)
	for i := range 40 {
		from, to := a, b
		if i%2 == 1 {
			from, to = b, a
		}
		wg.Go(func() {
			errs <- pgx.BeginFunc(context.WithoutCancel(t.Context()), d.pool, func(tx pgx.Tx) error {
				_, err := Post(t.Context(), tx, Entry{Kind: "transfer_internal", Reference: "x",
					Legs: []Leg{Debit(from, ngn(1_000)), Credit(to, ngn(1_000))}})
				return err
			})
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	d.wantBalances(a, 1_000_000, 1_000_000)
	d.wantBalances(b, 1_000_000, 1_000_000)
	d.wantNoDrift()
}
