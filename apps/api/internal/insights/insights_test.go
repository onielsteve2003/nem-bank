package insights

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

type profiles struct{ duress bool }

func (p profiles) CustomerProfile(context.Context, uuid.UUID) (identity.CustomerProfile, error) {
	return identity.CustomerProfile{InDuress: p.duress}, nil
}

func TestShares(t *testing.T) {
	t.Parallel()
	for _, in := range [][]int64{{1, 1, 1}, {500, 300, 200}, {1}, {}, {0, 0}, {333, 333, 334}} {
		got := Shares(in)
		sum := 0
		for _, g := range got {
			sum += g
		}
		var all int64
		for _, a := range in {
			all += a
		}
		if all > 0 && sum != 100 {
			t.Errorf("Shares(%v) = %v adds up to %d", in, got, sum)
		}
	}
	if got := Shares([]int64{3000, 1000}); got[0] != 75 || got[1] != 25 {
		t.Errorf("75/25 = %v", got)
	}
}

func TestSpendingBudgetsAndStory(t *testing.T) {
	t.Parallel()
	pool := testdb.New(t)
	ctx := t.Context()

	id := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, first_name, last_name, email, phone, nemtag, date_of_birth,
		password_hash, terms_version, privacy_version, consent_accepted_at)
		VALUES ($1, 'Ada', 'User', 'ins@example.com', '+2348066000011', 'ins1', '1996-04-12', 'x', '2026-10', '2026-10', now())`, id); err != nil {
		t.Fatal(err)
	}
	if err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		return accounts.OpenCurrentAccount(ctx, tx, identity.NewCustomer{UserID: id, Name: "Ada User"})
	}); err != nil {
		t.Fatal(err)
	}
	var ngn uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT account_id FROM customer_accounts WHERE user_id = $1 AND currency = 'NGN'`, id).Scan(&ngn); err != nil {
		t.Fatal(err)
	}
	record := func(typ, direction, category string, kobo int64, at time.Time) {
		t.Helper()
		err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
			src, err := ledger.SystemAccount(ctx, tx, ledger.KindDemoFunding, "NGN")
			if err != nil {
				return err
			}
			amt := money.New(kobo, money.NGN)
			legs := []ledger.Leg{ledger.Debit(src.ID, amt), ledger.Credit(ngn, amt)}
			if direction == "debit" {
				legs = []ledger.Leg{ledger.Debit(ngn, amt), ledger.Credit(src.ID, amt)}
			}
			posted, err := ledger.Post(ctx, tx, ledger.Entry{Kind: "demo_funding", Reference: "seed", Legs: legs})
			if err != nil {
				return err
			}
			_, err = accounts.Record(ctx, tx, accounts.Line{
				UserID: id, AccountID: ngn, Type: typ, Direction: direction, Status: "completed", Amount: amt, Entry: &posted,
				Narration: "seed", Reference: "seed", Category: category, At: at, Counterparty: api.Counterparty{Name: "Seed"},
			})
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	lagosNoon := func(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 12, 0, 0, 0, lagos) }
	record("deposit", "credit", "other", 1_000_000_00, lagosNoon(2026, 9, 1))
	record("card_payment", "debit", "food", 3_000_00, lagosNoon(2026, 11, 3))
	record("transfer_out", "debit", "transport", 1_000_00, lagosNoon(2026, 11, 9))
	record("fx_conversion", "debit", "other", 50_000_00, lagosNoon(2026, 11, 9)) // not spending
	record("savings", "debit", "savings", 5_000_00, lagosNoon(2026, 11, 10))     // not spending
	record("card_payment", "debit", "food", 2_000_00, lagosNoon(2026, 10, 20))
	// 23:30 UTC on 30 Nov is already 1 Dec in Lagos: it belongs to December.
	record("card_payment", "debit", "shopping", 700_00, time.Date(2026, 11, 30, 23, 30, 0, 0, time.UTC))

	svc, err := NewService(Config{Pool: pool, Customers: profiles{}, Now: func() time.Time { return lagosNoon(2026, 11, 15) }})
	if err != nil {
		t.Fatal(err)
	}
	me := identity.WithPrincipal(ctx, identity.Principal{UserID: id})

	b, err := svc.Spending(me, "", "")
	if err != nil {
		t.Fatalf("spending: %v", err)
	}
	if b.Month.String() != "2026-11" || b.Total != 4_000_00 || b.PreviousTotal != 2_000_00 || len(b.Categories) != 2 {
		t.Fatalf("breakdown = %+v", b)
	}
	if c := b.Categories[0]; c.Category != "food" || c.Share != 75 || c.Previous != 2_000_00 {
		t.Fatalf("top = %+v", c)
	}
	if dec, _ := svc.Spending(me, "2026-12", "NGN"); dec.Total != 700_00 {
		t.Fatalf("the late-night payment belongs to December in Lagos: %+v", dec)
	}
	if _, err := svc.Spending(me, "2026-13", ""); err == nil {
		t.Fatal("a bad month must be refused")
	}

	// Budgets: create, duplicate, status as spending grows, update, delete, other people's.
	food, err := svc.CreateBudget(me, "food", "NGN", 3_500_00)
	if err != nil || food.Spent != 3_000_00 || food.Status() != "warning" {
		t.Fatalf("food budget = %+v, %v", food, err)
	}
	if _, err = svc.CreateBudget(me, "food", "NGN", 1_00); !errors.Is(err, errBudgetExists) {
		t.Fatalf("duplicate: %v", err)
	}
	if _, err = svc.CreateBudget(me, "cash", "USD", 1_00); err == nil {
		t.Fatal("a dollar budget must be refused")
	}
	if _, err = svc.CreateBudget(me, "cash", "NGN", 0); err == nil {
		t.Fatal("a zero budget must be refused")
	}
	up, err := svc.UpdateBudget(me, food.ID, "NGN", 2_000_00)
	if err != nil || up.Status() != "exceeded" {
		t.Fatalf("update = %+v, %v", up, err)
	}
	up, _ = svc.UpdateBudget(me, food.ID, "NGN", 10_000_00)
	if up.Status() != "ok" {
		t.Fatalf("roomy budget = %s", up.Status())
	}
	stranger := identity.WithPrincipal(ctx, identity.Principal{UserID: uuid.New()})
	if _, err = svc.UpdateBudget(stranger, food.ID, "NGN", 1_00); !errors.Is(err, problem.NotFound("Budget")) {
		t.Fatalf("another customer's budget: %v", err)
	}
	if list, _ := svc.ListBudgets(me); len(list) != 1 {
		t.Fatalf("budgets = %+v", list)
	}
	if err := svc.DeleteBudget(me, food.ID); err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteBudget(me, food.ID); !errors.Is(err, problem.NotFound("Budget")) {
		t.Fatalf("second delete: %v", err)
	}

	// The story for November: intro, spent, top, biggest day, saved, compared, tip, outro.
	st, err := svc.MoneyStory(me, "2026-11")
	if err != nil || len(st.Slides) != 8 || st.Slides[1].Kind != "total_spent" || *st.Slides[1].Amount != 4_000_00 {
		t.Fatalf("story = %+v, %v", st, err)
	}
	if got := *st.Slides[4].Amount; st.Slides[4].Kind != "saved" || got != 5_000_00 {
		t.Fatalf("saved slide = %+v", st.Slides[4])
	}
	// The duress decoy shows no history.
	decoy, _ := NewService(Config{Pool: pool, Customers: profiles{duress: true}, Now: svc.now})
	if d, _ := decoy.Spending(me, "", ""); d.Total != 0 || len(d.Categories) != 0 {
		t.Fatalf("decoy = %+v", d)
	}
	if _, err := svc.Spending(context.Background(), "", ""); err == nil {
		t.Fatal("unauthenticated must be refused")
	}
}

func TestNaira(t *testing.T) {
	t.Parallel()
	for in, want := range map[int64]string{0: "₦0", 100: "₦1", 123_456_700: "₦1,234,567", 50: "₦0.50", -150_000: "-₦1,500"} {
		if got := naira(in); got != want {
			t.Errorf("naira(%d) = %q, want %q", in, got, want)
		}
	}
}
