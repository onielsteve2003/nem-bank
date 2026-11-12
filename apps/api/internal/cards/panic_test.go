package cards

import (
	"testing"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/panicmode"
)

func TestPanicModeFreezesCardsAndReleaseUnfreezesOnlyThose(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00, 0)
	button, err := panicmode.NewService(panicmode.Config{Pool: f.pool, StepUps: f.steps, Now: f.clk.Now})
	if err != nil {
		t.Fatal(err)
	}
	pressed := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	mine := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	if _, err := f.svc.Freeze(c.ctx, mine.card.ID); err != nil {
		t.Fatal(err)
	}

	st, err := button.Get(c.ctx)
	if err != nil || st.Active || st.OutgoingBlocked || st.CardsFrozen != 0 {
		t.Fatalf("before = %+v, %v", st, err)
	}
	st, err = button.Activate(c.ctx)
	if err != nil || !st.Active || !st.OutgoingBlocked || st.CardsFrozen != 1 || st.ActivatedAt == nil {
		t.Fatalf("activate = %+v, %v; want on, 1 card frozen (the other was frozen already)", st, err)
	}
	// Pressing it again changes nothing.
	if again, err := button.Activate(c.ctx); err != nil || again.CardsFrozen != 1 || !again.ActivatedAt.Equal(*st.ActivatedAt) {
		t.Fatalf("second press = %+v, %v", again, err)
	}
	if a, err := f.svc.Authorize(t.Context(), pressed.charge(naira(100), ChannelOnline)); err != nil || a.Status != AuthDeclined {
		t.Fatalf("charge while panicking = %+v, %v; want declined", a, err)
	}
	// One card cannot be unfrozen on its own while panic mode is on, step-up or not.
	f.steps.reset()
	_, err = f.svc.Unfreeze(c.ctx, pressed.card.ID, "good")
	wantProblem(t, err, "invalid_state")

	// Releasing needs a step-up and is a no-op, with no step-up spent, once off.
	f.steps.reset()
	_, err = button.Release(c.ctx, "")
	wantProblem(t, err, "step_up_required")
	st, err = button.Release(c.ctx, "good")
	if err != nil || st.Active || st.OutgoingBlocked || st.CardsFrozen != 0 || st.ActivatedAt != nil {
		t.Fatalf("release = %+v, %v", st, err)
	}
	if _, err := button.Release(c.ctx, ""); err != nil {
		t.Fatalf("release when off: %v", err)
	}

	got, err := f.svc.Get(c.ctx, pressed.card.ID)
	if err != nil || got.Status != StatusActive || got.FrozenByPanic {
		t.Fatalf("panic-frozen card after release = %+v, %v; want active", got, err)
	}
	got, err = f.svc.Get(c.ctx, mine.card.ID)
	if err != nil || got.Status != StatusFrozen {
		t.Fatalf("customer-frozen card after release = %+v, %v; want still frozen", got, err)
	}
	var events int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM outbox_events WHERE topic = 'security.panic_changed'`).Scan(&events); err != nil || events != 2 {
		t.Fatalf("panic events = %d, %v; want 2 (on, off)", events, err)
	}
}
