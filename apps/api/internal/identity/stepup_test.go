package identity

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

func strp(s string) *string { return &s }

// deviceSign signs like the app's signWithDeviceKey with the key of phone(n).
func deviceSign(n byte, msg string) string {
	seed := make([]byte, ed25519.SeedSize)
	seed[0] = n
	return base64.RawURLEncoding.EncodeToString(ed25519.Sign(ed25519.NewKeyFromSeed(seed), []byte(msg)))
}

func TestStepUpWithThePinUnlocksOnlyItsPurposeOnce(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	ctx, _ := h.withPin(t)

	st, err := h.svc.StartStepUp(ctx, "pin_reset")
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	// The mock's shape: PIN or email code, and the code's challenge is the step-up itself.
	if len(st.Methods) != 2 || st.Methods[0] != "pin" || st.Methods[1] != "email_otp" || st.Challenge.ID != st.ID {
		t.Fatalf("step-up = %+v", st)
	}
	tok, err := h.svc.VerifyStepUp(ctx, st.ID, StepUpProof{Pin: strp("2580")})
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if tok.Purpose != "pin_reset" || tok.ExpiresAt.Sub(h.clock.Now()) != 5*time.Minute {
		t.Fatalf("token = %+v", tok)
	}
	// One proof, one token: the same step-up cannot be passed again.
	_, err = h.svc.VerifyStepUp(ctx, st.ID, StepUpProof{Pin: strp("2580")})
	wantProblem(t, err, ErrStepUpExpired)

	if err := h.svc.ResetPin(ctx, tok.Token, "4815"); err != nil {
		t.Fatalf("reset with the token: %v", err)
	}
	wantProblem(t, h.svc.ResetPin(ctx, tok.Token, "1357"), ErrStepUpRequired)

	card, _ := h.svc.StartStepUp(ctx, "card_reveal")
	other, err := h.svc.VerifyStepUp(ctx, card.ID, StepUpProof{Pin: strp("4815")})
	if err != nil {
		t.Fatal(err)
	}
	wantProblem(t, h.svc.ResetPin(ctx, other.Token, "1357"), ErrStepUpRequired)
}

func TestStepUpByEmailCodeCanBeResentOnTheSameID(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	ctx, _ := h.withPin(t)

	st, err := h.svc.StartStepUp(ctx, "transfer")
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.svc.VerifyStepUp(ctx, st.ID, StepUpProof{OTPCode: strp(wrongCode(h.inbox.lastCode(t)))})
	var p *problem.Error
	if !errors.As(err, &p) || p.Code != "invalid_otp" || p.Detail != "4 attempts left." {
		t.Fatalf("wrong code: %v", err)
	}
	// The app's "send again" calls POST /v1/auth/otp/resend with otp.challenge_id.
	h.clock.Advance(61 * time.Second)
	if _, err := h.svc.ResendCode(ctx, st.Challenge.ID); err != nil {
		t.Fatalf("resend: %v", err)
	}
	tok, err := h.svc.VerifyStepUp(ctx, st.ID, StepUpProof{OTPCode: strp(h.inbox.lastCode(t))})
	if err != nil || tok.Purpose != "transfer" || tok.ExpiresAt.Sub(h.clock.Now()) != 5*time.Minute {
		t.Fatalf("verify code: %+v, %v", tok, err)
	}
}

func TestStepUpPinErrorsAreTheOnesTheAppShows(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	ctx, _ := h.withPin(t)
	st, _ := h.svc.StartStepUp(ctx, "card_reveal")

	_, err := h.svc.VerifyStepUp(ctx, st.ID, StepUpProof{Pin: strp("1357")})
	var p *problem.Error
	if !errors.As(err, &p) || p.Status != http.StatusUnprocessableEntity || p.Code != "invalid_pin" || p.Detail != "4 attempts left." {
		t.Fatalf("wrong PIN: %v", err)
	}
	for range 4 {
		_, err = h.svc.VerifyStepUp(ctx, st.ID, StepUpProof{Pin: strp("1357")})
	}
	if !errors.As(err, &p) || p.Status != http.StatusLocked || p.Code != "pin_locked" ||
		p.Detail != "Too many wrong PINs. Try again in 30 minutes." || p.RetryAt.IsZero() {
		t.Fatalf("5th wrong PIN: %v", err)
	}
}

func TestStepUpByFaceIDChecksTheBoundDeviceKey(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	ctx, _ := h.withPin(t) // bound phone(1)
	st, _ := h.svc.StartStepUp(ctx, "card_reveal")

	for name, sig := range map[string]string{
		"another device's key": deviceSign(2, st.ID.String()),
		"another message":      deviceSign(1, "something else"),
		"not base64url":        "%%%",
	} {
		_, err := h.svc.VerifyStepUp(ctx, st.ID, StepUpProof{Signature: strp(sig)})
		if !errors.Is(err, ErrInvalidSignature) {
			t.Errorf("%s: err = %v, want invalid_signature", name, err)
		}
	}
	if _, err := h.svc.VerifyStepUp(ctx, st.ID, StepUpProof{Signature: strp(deviceSign(1, st.ID.String()))}); err != nil {
		t.Fatalf("device signature: %v", err)
	}
}

func TestStepUpRefusesMissingProofOthersStepUpsAndFloods(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	ctx, _ := h.withPin(t)
	st, _ := h.svc.StartStepUp(ctx, "unfreeze")

	_, err := h.svc.VerifyStepUp(ctx, st.ID, StepUpProof{})
	wantProblem(t, err, ErrStepUpNoProof)
	_, err = h.svc.VerifyStepUp(ctx, st.ID, StepUpProof{SecurityAnswer: strp("corona")})
	wantProblem(t, err, ErrInvalidAnswer)

	// A second customer cannot pass the first one's step-up.
	started, _ := h.svc.StartSignup(t.Context(), details("ada@example.com", "+2348031234568"))
	v, _ := h.svc.VerifyCode(t.Context(), started.Challenge.ID, h.inbox.lastCode(t))
	ada, err := h.svc.CompleteSignup(t.Context(), started.SignupID, v.Token, strongPassword, "9021", phone(2))
	if err != nil {
		t.Fatal(err)
	}
	adaCtx, _ := h.svc.Authenticate(t.Context(), ada.AccessToken)
	_, err = h.svc.VerifyStepUp(adaCtx, st.ID, StepUpProof{Pin: strp("9021")})
	wantProblem(t, err, ErrStepUpExpired)

	h.clock.Advance(10 * time.Minute)
	_, err = h.svc.VerifyStepUp(ctx, st.ID, StepUpProof{Pin: strp("2580")})
	wantProblem(t, err, ErrStepUpExpired)

	for range stepUpsPerHour - 1 { // one was started above
		if _, err := h.svc.StartStepUp(ctx, "transfer"); err != nil {
			t.Fatal(err)
		}
	}
	_, err = h.svc.StartStepUp(ctx, "transfer")
	wantProblem(t, err, ErrTooManyCodes)
}

// The vectors from packages/shared/src/pin.test.ts.
func TestFormatLockoutWaitMatchesTheApp(t *testing.T) {
	t.Parallel()

	for d, want := range map[time.Duration]string{
		12 * time.Second: "1 minute", 29*time.Minute + 30*time.Second: "30 minutes",
		61 * time.Minute: "2 hours", 24 * time.Hour: "1 day",
	} {
		if got := FormatLockoutWait(d); got != want {
			t.Errorf("FormatLockoutWait(%v) = %q, want %q", d, got, want)
		}
	}
}
