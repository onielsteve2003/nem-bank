package transfers

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/risk"
)

// held makes the rules hold a transfer for review: three quick small payments to one person (each
// fine alone) make a fourth, large one to someone new a burst from a new account.
func held(t *testing.T, f *fixture, from, big customer) View {
	t.Helper()
	small := f.customer("Small", "small"+from.number[6:], 0)
	for range 3 {
		if _, err := f.svc.Create(from.ctx, Request{SourceAccountID: from.account, Destination: toNem(small.number), Amount: ngn(500_000), Narration: "Lunch"}); err != nil {
			t.Fatal(err)
		}
	}
	v, err := f.svc.Create(from.ctx, Request{SourceAccountID: from.account, Destination: toNem(big.number), Amount: ngn(8_000_000), Narration: "Rent"})
	if err != nil {
		t.Fatal(err)
	}
	if v.Status != string(HeldForReview) {
		t.Fatalf("status = %s, want held_for_review", v.Status)
	}
	return v
}

func TestAReviewerReleasingAHeldTransferSendsIt(t *testing.T) {
	t.Parallel()
	f, _ := newRiskFixtureWith(t, risk.Config{Engine: risk.RulesOnly()})
	tolu, ada := f.customer("Tolu", "tolu", 10_000_000), f.customer("Ada", "ada", 0)
	v := held(t, f, tolu, ada)
	if f.balance(ada) != 0 {
		t.Fatal("money moved while the transfer was held")
	}

	recorded := 0
	if err := f.svc.DecideHeld(t.Context(), v.ID, true, func(_ context.Context, _ pgx.Tx) error { recorded++; return nil }); err != nil {
		t.Fatal(err)
	}
	if recorded != 1 || f.balance(ada) != 8_000_000-5_000 { // less the ₦50 levy on inflows of ₦10,000 or more
		t.Fatalf("recorded %d, Ada has %d", recorded, f.balance(ada))
	}
	got, err := f.svc.StaffView(t.Context(), v.ID)
	if err != nil || got.Status != string(Completed) {
		t.Fatalf("after release: %s, %v", got.Status, err)
	}
	// The same decision again is a conflict: it is no longer held.
	if err := f.svc.DecideHeld(t.Context(), v.ID, true, func(_ context.Context, _ pgx.Tx) error { return nil }); !errors.Is(err, errNotHeld) {
		t.Fatalf("second decision = %v, want errNotHeld", err)
	}
}

func TestAReviewerRejectingAHeldTransferGivesTheMoneyBack(t *testing.T) {
	t.Parallel()
	f, _ := newRiskFixtureWith(t, risk.Config{Engine: risk.RulesOnly()})
	tolu, ada := f.customer("Tolu", "tolu", 10_000_000), f.customer("Ada", "ada", 0)
	v := held(t, f, tolu, ada)

	if err := f.svc.DecideHeld(t.Context(), v.ID, false, func(_ context.Context, _ pgx.Tx) error { return nil }); err != nil {
		t.Fatal(err)
	}
	got, err := f.svc.StaffView(t.Context(), v.ID)
	if err != nil || got.Status != string(Rejected) {
		t.Fatalf("after reject: %s, %v", got.Status, err)
	}
	b, err := ledger.GetBalances(t.Context(), f.pool, tolu.account)
	if err != nil {
		t.Fatal(err)
	}
	// Nothing left the account except the three small payments, and nothing is still held.
	if b.Ledger.Amount() != 10_000_000-3*500_000 || b.Available.Amount() != b.Ledger.Amount() || f.balance(ada) != 0 {
		t.Fatalf("balances: ledger %d available %d, Ada %d", b.Ledger.Amount(), b.Available.Amount(), f.balance(ada))
	}
}

func TestAFailingRecordLeavesTheTransferHeld(t *testing.T) {
	t.Parallel()
	f, _ := newRiskFixtureWith(t, risk.Config{Engine: risk.RulesOnly()})
	tolu, ada := f.customer("Tolu", "tolu", 10_000_000), f.customer("Ada", "ada", 0)
	v := held(t, f, tolu, ada)
	boom := errors.New("case file unavailable")
	if err := f.svc.DecideHeld(t.Context(), v.ID, true, func(_ context.Context, _ pgx.Tx) error { return boom }); !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
	got, _ := f.svc.StaffView(t.Context(), v.ID)
	if got.Status != string(HeldForReview) || f.balance(ada) != 0 {
		t.Fatalf("a failed record changed things: %s, Ada %d", got.Status, f.balance(ada))
	}
}
