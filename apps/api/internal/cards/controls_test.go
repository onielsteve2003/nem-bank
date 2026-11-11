package cards

import (
	"testing"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/cards/cardsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

func ptr[T any](v T) *T { return &v }

// mustOK is for setup calls in tests that return a card and an error.
func mustOK(_ cardsdb.Card, err error) {
	if err != nil {
		panic(err)
	}
}

// cardsdbCard builds a card for the pure decision tests without a database.
type cardsdbCard struct {
	Status           string
	Type             string
	OnlineEnabled    bool
	International    bool
	MerchantID       *string
	SpendLimitMinor  *int64
	SpendLimitPeriod *string
}

func (c cardsdbCard) row() cardsdb.Card {
	return cardsdb.Card{
		Status: c.Status, Type: c.Type, OnlineEnabled: c.OnlineEnabled, InternationalEnabled: c.International,
		MerchantID: c.MerchantID, SpendLimitMinor: c.SpendLimitMinor, SpendLimitPeriod: c.SpendLimitPeriod,
	}
}

func TestFreezeAndUnfreeze(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})

	frozen, err := f.svc.Freeze(c.ctx, card.card.ID)
	if err != nil || frozen.Status != StatusFrozen {
		t.Fatalf("freeze = %+v, %v", frozen, err)
	}
	if again, err := f.svc.Freeze(c.ctx, card.card.ID); err != nil || again.Status != StatusFrozen {
		t.Fatalf("freezing a frozen card = %+v, %v; want it unchanged", again, err)
	}
	a, err := f.svc.Authorize(t.Context(), card.charge(naira(100), ChannelOnline))
	if err != nil || a.DeclineReason == nil || *a.DeclineReason != DeclineCardFrozen {
		t.Fatalf("charge on a frozen card = %+v, %v", a, err)
	}
	// An ordinary freeze lifts without step-up.
	active, err := f.svc.Unfreeze(c.ctx, card.card.ID, "")
	if err != nil || active.Status != StatusActive {
		t.Fatalf("unfreeze = %+v, %v", active, err)
	}
	if a, err := f.svc.Authorize(t.Context(), card.charge(naira(100), ChannelOnline)); err != nil || a.Status != AuthAuthorized {
		t.Fatalf("charge after unfreezing = %+v, %v", a, err)
	}
}

func TestUnfreezingAPanicFrozenCardNeedsStepUp(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(0, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	if _, err := f.pool.Exec(t.Context(), `UPDATE cards SET status = 'frozen', frozen_by_panic = true WHERE id = $1`, card.card.ID); err != nil {
		t.Fatal(err)
	}
	f.steps.reset()
	_, err := f.svc.Unfreeze(c.ctx, card.card.ID, "")
	wantProblem(t, err, "step_up_required")
	got, err := f.svc.Get(c.ctx, card.card.ID)
	if err != nil || got.Status != StatusFrozen || !got.FrozenByPanic {
		t.Fatalf("card after a refused unfreeze = %+v, %v; want still frozen by panic", got, err)
	}
	active, err := f.svc.Unfreeze(c.ctx, card.card.ID, "good")
	if err != nil || active.Status != StatusActive || active.FrozenByPanic {
		t.Fatalf("unfreeze with step-up = %+v, %v", active, err)
	}
}

func TestTerminateIsFinalAndKeepsPendingHolds(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	pending, err := f.svc.Authorize(t.Context(), card.charge(naira(2_000), ChannelOnline))
	if err != nil || pending.Status != AuthAuthorized {
		t.Fatal(pending, err)
	}
	done, err := f.svc.Terminate(c.ctx, card.card.ID)
	if err != nil || done.Status != StatusTerminated || done.TerminatedAt == nil {
		t.Fatalf("terminate = %+v, %v", done, err)
	}
	if again, err := f.svc.Terminate(c.ctx, card.card.ID); err != nil || again.Status != StatusTerminated {
		t.Fatalf("terminating twice = %+v, %v", again, err)
	}
	// What the merchant already authorised is still held and still settles (CARD-6).
	var status string
	if err := f.pool.QueryRow(t.Context(), `SELECT status FROM account_holds WHERE id = $1`, *pending.HoldID).Scan(&status); err != nil || status != "active" {
		t.Fatalf("hold after terminate = %q, %v", status, err)
	}
	_, err = f.svc.Authorize(t.Context(), card.charge(naira(100), ChannelOnline))
	wantProblem(t, err, "invalid_card")
	_, err = f.svc.UpdateControls(c.ctx, card.card.ID, Update{Online: ptr(false)})
	wantProblem(t, err, "invalid_state")
	_, err = f.svc.Freeze(c.ctx, card.card.ID)
	wantProblem(t, err, "invalid_state")
	_, err = f.svc.Unfreeze(c.ctx, card.card.ID, "")
	wantProblem(t, err, "invalid_state")
}

func TestReplaceTerminatesAndReissuesWithTheSameControls(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00, 0)
	old := f.issue(c, IssueRequest{
		AccountID: c.ngn, Type: TypeMerchantLocked, Nickname: "Bolt rides", Design: "mint",
		MerchantLock: &MerchantLock{ID: "m_bolt", Name: "Bolt"}, SpendLimit: &SpendLimit{Amount: naira(20_000), Period: Monthly},
	})
	mustOK(f.svc.UpdateControls(c.ctx, old.card.ID, Update{Online: ptr(false), International: ptr(true)}))

	fresh, err := f.svc.Replace(c.ctx, old.card.ID)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.ID == old.card.ID || fresh.Status != StatusActive || fresh.Type != TypeMerchantLocked || fresh.Design != "mint" ||
		fresh.Nickname == nil || *fresh.Nickname != "Bolt rides" || fresh.MerchantID == nil || *fresh.MerchantID != "m_bolt" ||
		fresh.SpendLimitMinor == nil || *fresh.SpendLimitMinor != 20_000_00 || *fresh.SpendLimitPeriod != Monthly ||
		fresh.OnlineEnabled || !fresh.InternationalEnabled || fresh.AccountID != c.ngn {
		t.Fatalf("replacement = %+v", fresh)
	}
	f.steps.reset()
	secrets, err := f.svc.Reveal(c.ctx, fresh.ID, "good")
	if err != nil || secrets.PAN == old.pan {
		t.Fatalf("replacement number = %q (old %q), %v; want a new number", secrets.PAN, old.pan, err)
	}
	if gone, _ := f.svc.Get(c.ctx, old.card.ID); gone.Status != StatusTerminated {
		t.Fatalf("old card = %s, want terminated", gone.Status)
	}
	// The old number no longer works.
	_, err = f.svc.Authorize(t.Context(), old.charge(naira(100), ChannelInStore))
	wantProblem(t, err, "invalid_card")
	// Replacing a card that is already gone is refused.
	_, err = f.svc.Replace(c.ctx, old.card.ID)
	wantProblem(t, err, "invalid_state")
}

func TestReplaceWorksAtTheCardLimit(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(0, 0)
	var last cardsdb.Card
	for range maxLiveCards {
		var err error
		if last, err = f.svc.Issue(c.ctx, IssueRequest{AccountID: c.ngn, Type: TypeStandard}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.svc.Replace(c.ctx, last.ID); err != nil {
		t.Fatalf("replace at the limit: %v", err)
	}
	live := 0
	list, _ := f.svc.List(c.ctx)
	for _, card := range list {
		if card.Status == StatusActive {
			live++
		}
	}
	if live != maxLiveCards {
		t.Fatalf("%d live cards after a replacement, want %d", live, maxLiveCards)
	}
}

func TestUpdateControls(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard, Nickname: "Old"})

	got, err := f.svc.UpdateControls(c.ctx, card.card.ID, Update{
		Nickname: ptr("  New  "), SpendLimit: &SpendLimit{Amount: naira(1_500), Period: Daily},
		MerchantLock: &MerchantLock{ID: "m1", Name: "Shop"}, Online: ptr(false), International: ptr(true),
	})
	if err != nil {
		t.Fatal(err)
	}
	if *got.Nickname != "New" || *got.SpendLimitMinor != 1_500_00 || *got.SpendLimitPeriod != Daily || *got.MerchantID != "m1" ||
		got.OnlineEnabled || !got.InternationalEnabled {
		t.Fatalf("updated = %+v", got)
	}
	// An update with nothing to say leaves everything as it is.
	same, err := f.svc.UpdateControls(c.ctx, card.card.ID, Update{})
	if err != nil || *same.SpendLimitMinor != 1_500_00 || *same.MerchantID != "m1" {
		t.Fatalf("empty update = %+v, %v", same, err)
	}
	cleared, err := f.svc.UpdateControls(c.ctx, card.card.ID, Update{ClearLimit: true, ClearLock: true, Nickname: ptr("")})
	if err != nil || cleared.SpendLimitMinor != nil || cleared.SpendLimitPeriod != nil || cleared.MerchantID != nil || cleared.Nickname != nil {
		t.Fatalf("cleared = %+v, %v", cleared, err)
	}
	_, err = f.svc.UpdateControls(c.ctx, card.card.ID, Update{SpendLimit: &SpendLimit{Amount: money.New(100, money.USD), Period: Daily}})
	wantProblem(t, err, "validation_failed")

	locked := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeMerchantLocked, MerchantLock: &MerchantLock{ID: "m1", Name: "Shop"}})
	_, err = f.svc.UpdateControls(c.ctx, locked.card.ID, Update{ClearLock: true})
	wantProblem(t, err, "validation_failed")
	moved, err := f.svc.UpdateControls(c.ctx, locked.card.ID, Update{MerchantLock: &MerchantLock{ID: "m2", Name: "Other"}})
	if err != nil || *moved.MerchantID != "m2" {
		t.Fatalf("moving the lock = %+v, %v", moved, err)
	}
}

func TestControlsBelongToTheOwner(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(0, 0)
	other := f.customer(0, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	for name, err := range map[string]error{
		"freeze":    second(f.svc.Freeze(other.ctx, card.card.ID)),
		"unfreeze":  second(f.svc.Unfreeze(other.ctx, card.card.ID, "good")),
		"terminate": second(f.svc.Terminate(other.ctx, card.card.ID)),
		"replace":   second(f.svc.Replace(other.ctx, card.card.ID)),
		"update":    second(f.svc.UpdateControls(other.ctx, card.card.ID, Update{Online: ptr(false)})),
		"missing":   second(f.svc.Freeze(c.ctx, uuid.New())),
	} {
		if err == nil {
			t.Errorf("%s: another customer's card was changed", name)
		}
	}
	if got, _ := f.svc.Get(c.ctx, card.card.ID); got.Status != StatusActive {
		t.Fatalf("card status = %s after refused changes", got.Status)
	}
}

func second(_ cardsdb.Card, err error) error { return err }
