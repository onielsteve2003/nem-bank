package identity

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

// The vectors from packages/shared/src/pin.test.ts.
func TestIsWeakPinMatchesTheSharedRules(t *testing.T) {
	t.Parallel()

	dob := time.Date(1994, 3, 5, 0, 0, 0, 0, time.UTC)
	for _, pin := range []string{"1111", "000000", "1234", "4321", "123456", "987654"} {
		if !IsWeakPin(pin, time.Time{}) {
			t.Errorf("IsWeakPin(%q) = false, want weak", pin)
		}
	}
	for _, pin := range []string{"2580", "1357", "9021", "481516"} {
		if IsWeakPin(pin, time.Time{}) {
			t.Errorf("IsWeakPin(%q) = true, want accepted", pin)
		}
	}
	for _, pin := range []string{"1994", "0503", "0305", "0394", "050394", "030594", "940305"} {
		if !IsWeakPin(pin, dob) {
			t.Errorf("IsWeakPin(%q, 1994-03-05) = false, want a birthday PIN", pin)
		}
	}
	if IsWeakPin("2580", dob) || IsWeakPin("0503", time.Time{}) {
		t.Error("a strong PIN, or a birthday form with no date known, was refused")
	}
}

func TestPinLockoutQuadruplesUpToADay(t *testing.T) {
	t.Parallel()

	want := []time.Duration{30 * time.Minute, 2 * time.Hour, 8 * time.Hour, 24 * time.Hour, 24 * time.Hour}
	for i, w := range want {
		if got := PinLockout(i + 1); got != w {
			t.Errorf("PinLockout(%d) = %v, want %v", i+1, got, w)
		}
	}
}

// withPin signs up a customer who chose PIN 2580 at sign-up, and returns their context.
func (h *harness) withPin(t *testing.T) (context.Context, AuthResult) {
	t.Helper()
	ctx := t.Context()
	started, err := h.svc.StartSignup(ctx, details("tolu@example.com", "+2348031234567"))
	if err != nil {
		t.Fatal(err)
	}
	v, err := h.svc.VerifyCode(ctx, started.Challenge.ID, h.inbox.lastCode(t))
	if err != nil {
		t.Fatal(err)
	}
	// 1996-04-12: 0412 is a birthday PIN and is refused at sign-up.
	_, err = h.svc.CompleteSignup(ctx, started.SignupID, v.Token, strongPassword, "0412", phone(1))
	wantProblem(t, err, ErrWeakPin)
	res, err := h.svc.CompleteSignup(ctx, started.SignupID, v.Token, strongPassword, "2580", phone(1))
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	authed, err := h.svc.Authenticate(ctx, res.AccessToken)
	if err != nil {
		t.Fatal(err)
	}
	return authed, res
}

// stepUp stands in for the step-up flow, which is not built yet: it stores a verified
// step-up challenge for purpose and returns its token.
func (h *harness) stepUp(t *testing.T, userID uuid.UUID, purpose string) string {
	t.Helper()
	token, err := newToken()
	if err != nil {
		t.Fatal(err)
	}
	now := h.clock.Now()
	_, err = h.svc.pool.Exec(t.Context(), `
		INSERT INTO otp_challenges (id, purpose, step_up_purpose, subject_id, destination, code_hash,
		  attempts_left, expires_at, resend_available_at, verified_at, token_hash, token_expires_at)
		VALUES ($1, 'step_up', $2, $3, 'tolu@example.com', '\x00', 5, $4, $4, $5, $6, $4)`,
		uuid.Must(uuid.NewV7()), purpose, userID, now.Add(5*time.Minute), now, hashToken(token))
	if err != nil {
		t.Fatalf("insert step-up: %v", err)
	}
	return token
}

func TestPinLocksAfterFiveWrongTriesWithEscalatingBackoff(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	ctx, res := h.withPin(t)

	if res.User.PinHash == nil {
		t.Fatal("sign-up with a PIN left has_pin false")
	}
	if err := h.svc.SetPin(ctx, "9021"); !errors.Is(err, ErrPinExists) {
		t.Fatalf("second SetPin: err = %v, want pin_exists", err)
	}

	for want := 4; want >= 1; want-- {
		r, err := h.svc.VerifyPin(ctx, "1357")
		if err != nil || r.Valid || r.AttemptsLeft != want || r.LockedUntil != nil {
			t.Fatalf("wrong PIN: %+v, err %v, want %d left", r, err, want)
		}
	}
	r, _ := h.svc.VerifyPin(ctx, "1357")
	if r.LockedUntil == nil || r.LockedUntil.Sub(h.clock.Now()) != 30*time.Minute || r.AttemptsLeft != 0 {
		t.Fatalf("5th wrong PIN: %+v, want a 30-minute lockout", r)
	}
	// Locked: even the right PIN is not checked.
	if r, _ := h.svc.VerifyPin(ctx, "2580"); r.Valid || r.LockedUntil == nil {
		t.Fatalf("right PIN while locked: %+v", r)
	}

	h.clock.Advance(30 * time.Minute)
	for range 5 {
		r, _ = h.svc.VerifyPin(ctx, "1357")
	}
	if r.LockedUntil == nil || r.LockedUntil.Sub(h.clock.Now()) != 2*time.Hour {
		t.Fatalf("second lockout: %+v, want 2 hours", r)
	}

	h.clock.Advance(2 * time.Hour)
	if r, err := h.svc.VerifyPin(ctx, "2580"); err != nil || !r.Valid || r.AttemptsLeft != 5 {
		t.Fatalf("right PIN after the lockout: %+v, err %v", r, err)
	}
	// A correct PIN starts the backoff again: the next lockout is 30 minutes.
	for range 5 {
		r, _ = h.svc.VerifyPin(ctx, "1357")
	}
	if r.LockedUntil.Sub(h.clock.Now()) != 30*time.Minute {
		t.Fatalf("backoff did not reset: %+v", r)
	}
}

func TestDuressPinLooksValidAndSilentlySwitchesModes(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	ctx, res := h.withPin(t)
	uid := res.User.ID

	err := h.svc.SetDuressPin(ctx, h.stepUp(t, uid, "pin_reset"), "2580")
	wantProblem(t, err, ErrDuressSameAsPin)
	if err := h.svc.SetDuressPin(ctx, h.stepUp(t, uid, "pin_reset"), "9021"); err != nil {
		t.Fatalf("set duress pin: %v", err)
	}

	r, err := h.svc.VerifyPin(ctx, "9021")
	if err != nil || r != (PinResult{Valid: true, AttemptsLeft: PinMaxAttempts}) {
		t.Fatalf("duress PIN: %+v, err %v; must look exactly like the real PIN", r, err)
	}
	if in, _ := h.svc.InDuress(ctx, uid); !in {
		t.Fatal("duress PIN did not switch on duress mode")
	}
	_, _ = h.svc.VerifyPin(ctx, "9021")
	if n := count(t, h, "SELECT count(*) FROM outbox_events WHERE topic = 'security.duress_triggered'"); n != 1 {
		t.Fatalf("duress alerts = %d, want 1 (only on entering duress)", n)
	}

	// Under duress, removing the duress PIN "works" but changes nothing.
	if err := h.svc.RemoveDuressPin(ctx, h.stepUp(t, uid, "pin_reset")); err != nil {
		t.Fatalf("remove in duress: %v", err)
	}
	if err := h.svc.ResetPin(ctx, h.stepUp(t, uid, "pin_reset"), "4815"); err != nil {
		t.Fatalf("reset in duress: %v", err)
	}
	if r, _ := h.svc.VerifyPin(ctx, "2580"); !r.Valid {
		t.Fatal("the real PIN changed while in duress")
	}
	if in, _ := h.svc.InDuress(ctx, uid); in {
		t.Fatal("the real PIN did not end duress mode")
	}
	if r, _ := h.svc.VerifyPin(ctx, "9021"); !r.Valid {
		t.Fatal("the duress PIN was removed while in duress")
	}
}

func TestPinChangesNeedAFreshStepUpForThatPurpose(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	ctx, res := h.withPin(t)
	uid := res.User.ID

	wantProblem(t, h.svc.ResetPin(ctx, "", "4815"), ErrStepUpRequired)
	wantProblem(t, h.svc.ResetPin(ctx, h.stepUp(t, uid, "card_reveal"), "4815"), ErrStepUpRequired)
	wantProblem(t, h.svc.ResetPin(ctx, h.stepUp(t, uuid.Must(uuid.NewV7()), "pin_reset"), "4815"), ErrStepUpRequired)
	expired := h.stepUp(t, uid, "pin_reset")
	h.clock.Advance(6 * time.Minute)
	wantProblem(t, h.svc.ResetPin(ctx, expired, "4815"), ErrStepUpRequired)
	wantProblem(t, h.svc.ResetPin(ctx, h.stepUp(t, uid, "pin_reset"), "1111"), ErrWeakPin)

	token := h.stepUp(t, uid, "pin_reset")
	if err := h.svc.ResetPin(ctx, token, "4815"); err != nil {
		t.Fatalf("reset: %v", err)
	}
	wantProblem(t, h.svc.ResetPin(ctx, token, "1357"), ErrStepUpRequired) // single use
	if r, _ := h.svc.VerifyPin(ctx, "4815"); !r.Valid {
		t.Fatal("new PIN does not verify")
	}
}
