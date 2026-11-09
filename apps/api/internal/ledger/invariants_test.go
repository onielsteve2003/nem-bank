package ledger

import (
	"context"
	"errors"
	"math/rand/v2"
	"slices"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"pgregory.net/rapid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

// The ledger's invariants (PRD NFR money correctness), checked over the whole database:
//
//  1. every journal entry nets to zero in each currency;
//  2. all accounts together net to zero in each currency (double entry: money is only
//     ever moved, never created);
//  3. no customer deposit has a negative ledger or available balance;
//  4. every cached balance equals its postings, and available equals that minus the
//     active holds (Drift is empty).
type fataler interface {
	Helper()
	Fatalf(format string, args ...any)
}

func checkInvariants(ctx context.Context, t fataler, pool *pgxpool.Pool) {
	t.Helper()
	for name, sql := range map[string]string{
		"unbalanced entries": `SELECT count(*) FROM (SELECT entry_id FROM postings GROUP BY entry_id, currency
			HAVING sum(amount_minor) <> 0) x`,
		"currencies not netting to zero": `SELECT count(*) FROM (SELECT currency FROM ledger_accounts GROUP BY currency
			HAVING sum(balance_minor) <> 0) x`,
		"negative customer deposits": `SELECT count(*) FROM ledger_accounts
			WHERE kind IN ('customer_current', 'customer_wallet', 'customer_savings', 'customer_locked')
			AND (balance_minor < 0 OR available_minor < 0)`,
	} {
		var n int
		if err := pool.QueryRow(ctx, sql).Scan(&n); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if n != 0 {
			t.Fatalf("invariant broken: %d %s", n, name)
		}
	}
	drift, err := Drift(ctx, pool)
	if err != nil {
		t.Fatalf("drift: %v", err)
	}
	if len(drift) > 0 {
		t.Fatalf("invariant broken: cached balances drifted: %+v", drift)
	}
}

// model is what the test expects the ledger to hold, kept independently of it.
type model struct {
	balance, available map[uuid.UUID]int64
	holds              map[uuid.UUID]modelHold
}

type modelHold struct {
	account uuid.UUID
	amount  int64
}

// TestLedgerInvariantsHoldForAnySequenceOfOperations drives the engine with random
// sequences of funding, transfers, holds, releases, captures and FX conversions. Each
// operation must succeed exactly when the model says the money is there, the ledger must
// end where the model does, and the invariants must hold throughout.
func TestLedgerInvariantsHoldForAnySequenceOfOperations(t *testing.T) {
	t.Parallel()
	d := newDB(t)
	ctx := t.Context()
	funding, partner := d.system(KindDemoFunding, "NGN"), d.system(KindPartnerSettlement, "NGN")
	fxNGN, fxUSD := d.system(KindFXPosition, "NGN"), d.system(KindFXPosition, "USD")

	rapid.Check(t, func(rt *rapid.T) {
		// Fresh customers per run, so each run's model starts from zero on a shared database.
		accounts := []uuid.UUID{d.customer("NGN"), d.customer("NGN"), d.customer("NGN")}
		usd := d.customer("USD")
		m := model{balance: map[uuid.UUID]int64{}, available: map[uuid.UUID]int64{}, holds: map[uuid.UUID]modelHold{}}

		inTx := func(fn func(tx pgx.Tx) error) error { return pgx.BeginFunc(ctx, d.pool, fn) }
		post := func(e Entry) error {
			return inTx(func(tx pgx.Tx) error { _, err := Post(ctx, tx, e); return err })
		}
		// expect checks an operation's outcome against the model's prediction.
		expect := func(op string, ok bool, err error) {
			switch {
			case ok && err != nil:
				rt.Fatalf("%s: unexpected error %v", op, err)
			case !ok && !errors.Is(err, ErrInsufficientFunds):
				rt.Fatalf("%s: err = %v, want insufficient funds", op, err)
			}
		}
		pick := func(label string) uuid.UUID { return rapid.SampledFrom(accounts).Draw(rt, label) }
		// amount draws up to twice what is available, so about half the spends overdraw.
		amount := func(avail int64, label string) int64 {
			return rapid.Int64Range(1, 2*avail+1).Draw(rt, label)
		}
		activeHold := func() (uuid.UUID, modelHold, bool) {
			if len(m.holds) == 0 {
				return uuid.Nil, modelHold{}, false
			}
			ids := make([]uuid.UUID, 0, len(m.holds))
			for id := range m.holds {
				ids = append(ids, id)
			}
			slices.SortFunc(ids, compareIDs)
			id := rapid.SampledFrom(ids).Draw(rt, "hold")
			return id, m.holds[id], true
		}

		steps := rapid.IntRange(1, 25).Draw(rt, "steps")
		for range steps {
			switch rapid.SampledFrom([]string{"fund", "transfer", "hold", "release", "capture", "fx"}).Draw(rt, "op") {
			case "fund":
				to, amt := pick("to"), rapid.Int64Range(1, 1_000_000).Draw(rt, "amount")
				expect("fund", true, post(Entry{Kind: "demo_funding", Reference: "prop",
					Legs: []Leg{Debit(funding, ngn(amt)), Credit(to, ngn(amt))}}))
				m.balance[to] += amt
				m.available[to] += amt
			case "transfer":
				from, to := pick("from"), pick("to")
				if from == to {
					continue
				}
				amt := amount(m.available[from], "amount")
				ok := amt <= m.available[from]
				expect("transfer", ok, post(Entry{Kind: "transfer_internal", Reference: "prop",
					Legs: []Leg{Debit(from, ngn(amt)), Credit(to, ngn(amt))}}))
				if ok {
					m.balance[from] -= amt
					m.available[from] -= amt
					m.balance[to] += amt
					m.available[to] += amt
				}
			case "hold":
				on := pick("on")
				amt := amount(m.available[on], "amount")
				ok := amt <= m.available[on]
				var hold uuid.UUID
				expect("hold", ok, inTx(func(tx pgx.Tx) error {
					h, err := PlaceHold(ctx, tx, on, ngn(amt), "prop")
					hold = h.ID
					return err
				}))
				if ok {
					m.available[on] -= amt
					m.holds[hold] = modelHold{on, amt}
				}
			case "release":
				id, h, ok := activeHold()
				if !ok {
					continue
				}
				expect("release", true, inTx(func(tx pgx.Tx) error { return ReleaseHold(ctx, tx, id) }))
				m.available[h.account] += h.amount
				delete(m.holds, id)
			case "capture":
				// Settles a hold for a final amount that may differ from it (card settlement).
				id, h, ok := activeHold()
				if !ok {
					continue
				}
				spendable := m.available[h.account] + h.amount
				amt := amount(spendable, "amount")
				ok = amt <= spendable
				expect("capture", ok, post(Entry{Kind: "transfer_external", Reference: "prop", Capture: []uuid.UUID{id},
					Legs: []Leg{Debit(h.account, ngn(amt)), Credit(partner, ngn(amt))}}))
				if ok {
					m.balance[h.account] -= amt
					m.available[h.account] = spendable - amt
					delete(m.holds, id)
				}
			case "fx":
				from := pick("from")
				amt := amount(m.available[from], "naira")
				cents := max(amt/1500, 1) // the rate is not the point; each currency balances alone
				ok := amt <= m.available[from]
				expect("fx", ok, post(Entry{Kind: "fx_conversion", Reference: "prop", Legs: []Leg{
					Debit(from, ngn(amt)), Credit(fxNGN, ngn(amt)),
					Debit(fxUSD, money.New(cents, money.USD)), Credit(usd, money.New(cents, money.USD)),
				}}))
				if ok {
					m.balance[from] -= amt
					m.available[from] -= amt
					m.balance[usd] += cents
					m.available[usd] += cents
				}
			}
		}

		for _, a := range append(accounts, usd) {
			b, err := GetBalances(ctx, d.pool, a)
			if err != nil {
				rt.Fatalf("balances: %v", err)
			}
			if b.Ledger.Amount() != m.balance[a] || b.Available.Amount() != m.available[a] {
				rt.Fatalf("account %s = %d / %d, model says %d / %d", a, b.Ledger.Amount(), b.Available.Amount(), m.balance[a], m.available[a])
			}
		}
		checkInvariants(ctx, rt, d.pool)
	})
}

// TestAThousandParallelTransfersKeepTheLedgerExact fires 1,000 concurrent transfers
// between ten accounts, many of them overdrawing. Every one must either post or be refused
// for insufficient funds: a deadlock, a lost update or a negative balance fails the test.
// CI runs it with -race.
func TestAThousandParallelTransfersKeepTheLedgerExact(t *testing.T) {
	t.Parallel()
	d := newDB(t)
	const accounts, transfers, start = 10, 1000, 100_000
	ids := make([]uuid.UUID, accounts)
	for i := range ids {
		ids[i] = d.customer("NGN")
		d.fund(ids[i], start)
	}

	type job struct {
		from, to uuid.UUID
		amount   int64
	}
	rng := rand.New(rand.NewPCG(24, 5)) // fixed seed: a failure reproduces
	jobs := make([]job, transfers)
	for i := range jobs {
		from := rng.IntN(accounts)
		to := (from + 1 + rng.IntN(accounts-1)) % accounts
		jobs[i] = job{ids[from], ids[to], 1 + rng.Int64N(30_000)}
	}

	ctx := context.WithoutCancel(t.Context())
	var posted, refused atomic.Int64
	errs := make(chan error, transfers)
	var wg sync.WaitGroup
	for _, j := range jobs {
		wg.Go(func() {
			err := pgx.BeginFunc(ctx, d.pool, func(tx pgx.Tx) error {
				_, err := Post(ctx, tx, Entry{Kind: "transfer_internal", Reference: "load",
					Legs: []Leg{Debit(j.from, ngn(j.amount)), Credit(j.to, ngn(j.amount))}})
				return err
			})
			switch {
			case err == nil:
				posted.Add(1)
			case errors.Is(err, ErrInsufficientFunds):
				refused.Add(1)
			default:
				errs <- err
			}
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("transfer failed for a reason other than funds: %v", err)
	}
	if posted.Load()+refused.Load() != transfers || posted.Load() == 0 {
		t.Fatalf("posted %d, refused %d", posted.Load(), refused.Load())
	}

	// Money only moved between the ten accounts, so their total is unchanged.
	var total int64
	for _, id := range ids {
		l, a := d.balances(id)
		if l != a {
			t.Fatalf("no holds, yet ledger %d != available %d", l, a)
		}
		total += l
	}
	if total != accounts*start {
		t.Fatalf("customers hold %d in total, want %d", total, accounts*start)
	}
	var entries int64
	if err := d.pool.QueryRow(ctx, `SELECT count(*) FROM journal_entries WHERE reference = 'load'`).Scan(&entries); err != nil {
		t.Fatal(err)
	}
	if entries != posted.Load() {
		t.Fatalf("%d entries for %d posted transfers", entries, posted.Load())
	}
	checkInvariants(ctx, t, d.pool)
}
