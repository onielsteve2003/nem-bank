package identity

import (
	"testing"
	"time"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// signedUpOn is signedUp with its own device key, since a key belongs to one account.
func (h *harness) signedUpOn(t *testing.T, email, tel string, dev DeviceRegistration) AuthResult {
	t.Helper()
	ctx := t.Context()
	started, err := h.svc.StartSignup(ctx, details(email, tel))
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	v, err := h.svc.VerifyCode(ctx, started.Challenge.ID, h.inbox.lastCode(t))
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	res, err := h.svc.CompleteSignup(ctx, started.SignupID, v.Token, strongPassword, "", dev)
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	return res
}

func TestNemtagClaimChangeCooldownAndHold(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	a := h.signedUp(t, "ada@example.com", "+2348031230101")
	b := h.signedUpOn(t, "bayo@example.com", "+2348031230102", phone(2))
	ctxA := WithPrincipal(t.Context(), Principal{UserID: a.User.ID})
	ctxB := WithPrincipal(t.Context(), Principal{UserID: b.User.ID})

	// Free handle: available, no suggestions. A reserved one is not.
	r, err := h.svc.CheckNemtag(ctxA, "@Ada_N ")
	if err != nil || !r.Available || r.Nemtag != "ada_n" || len(r.Suggestions) != 0 {
		t.Fatalf("free check = %+v, %v", r, err)
	}
	if r, _ = h.svc.CheckNemtag(ctxA, "admin"); r.Available {
		t.Fatal("a reserved handle must not be available")
	}

	// First claim has no cooldown.
	u, err := h.svc.SetNemtag(ctxA, "ada_n")
	if err != nil || u.Nemtag == nil || *u.Nemtag != "ada_n" || u.NemtagChangedAt != nil {
		t.Fatalf("first claim = %+v, %v", u, err)
	}
	// Someone else cannot take it, and is offered other ideas.
	_, err = h.svc.SetNemtag(ctxB, "ada_n")
	wantProblem(t, err, errNemtagTaken)
	r, _ = h.svc.CheckNemtag(ctxB, "ada_n")
	if r.Available || len(r.Suggestions) == 0 {
		t.Fatalf("taken check = %+v", r)
	}
	// Same tag again, bad shape, reserved.
	if _, err = h.svc.SetNemtag(ctxA, "ada_n"); err == nil {
		t.Fatal("setting the same tag must fail")
	}
	if _, err = h.svc.SetNemtag(ctxA, "9bad"); err == nil {
		t.Fatal("a bad shape must fail")
	}

	// Change once, then the cooldown bites; the old tag stays held for the owner only.
	if _, err = h.svc.SetNemtag(ctxA, "ada_new"); err != nil {
		t.Fatalf("change: %v", err)
	}
	_, err = h.svc.SetNemtag(ctxA, "ada_again")
	wantProblem(t, err, errNemtagCooldown)
	_, err = h.svc.SetNemtag(ctxB, "ada_n")
	wantProblem(t, err, errNemtagTaken)

	// After 30 days the cooldown and the hold are over: B can take it.
	h.clock.Advance(31 * 24 * time.Hour)
	if _, err = h.svc.SetNemtag(ctxB, "ada_n"); err != nil {
		t.Fatalf("after the hold: %v", err)
	}

	// Unauthenticated calls are refused.
	_, err = h.svc.CheckNemtag(t.Context(), "x_y_z")
	wantProblem(t, err, problem.Unauthorized())
}
