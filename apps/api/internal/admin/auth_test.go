package admin

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestStaffLoginNeedsThePasswordThenAFreshTOTPCode(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	ctx := t.Context()
	st, secret := h.member(t, "Aisha Bello", "Aisha@Nem.Bank", RoleCompliance)

	// Wrong password and unknown email look the same.
	_, err := h.svc.Login(ctx, "aisha@nem.bank", "Wrong-Password-123456")
	wantProblem(t, err, ErrInvalidCredentials)
	_, err = h.svc.Login(ctx, "nobody@nem.bank", staffPassword)
	wantProblem(t, err, ErrInvalidCredentials)

	// First login: the challenge carries the enrolment QR.
	ch, err := h.svc.Login(ctx, " AISHA@nem.bank ", staffPassword)
	if err != nil || ch.EnrolmentURI == nil || ch.ExpiresAt.Sub(h.clock.Now()) != challengeTTL {
		t.Fatalf("first challenge = %+v, %v", ch, err)
	}
	wantProblem(t, func() error { _, err := h.svc.VerifyTOTP(ctx, ch.ID, "000000"); return err }(), ErrInvalidTOTP)
	code := h.code(secret)
	sess, err := h.svc.VerifyTOTP(ctx, ch.ID, code)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if sess.Staff.TotpEnrolledAt == nil || sess.ExpiresAt.Sub(h.clock.Now()) != 8*time.Hour {
		t.Fatalf("session = %+v", sess)
	}
	// A used challenge cannot open a second session.
	_, err = h.svc.VerifyTOTP(ctx, ch.ID, code)
	wantProblem(t, err, ErrChallengeExpired)

	// Enrolled now: no QR, and the same code (same time step) is refused as a replay.
	again, err := h.svc.Login(ctx, "aisha@nem.bank", staffPassword)
	if err != nil || again.EnrolmentURI != nil {
		t.Fatalf("second challenge = %+v, %v", again, err)
	}
	_, err = h.svc.VerifyTOTP(ctx, again.ID, code)
	wantProblem(t, err, ErrInvalidTOTP)
	h.clock.Advance(30 * time.Second)
	if _, err := h.svc.VerifyTOTP(ctx, again.ID, h.code(secret)); err != nil {
		t.Fatalf("next step's code: %v", err)
	}

	// Failures: the wrong password, "000000" and the replay. The unknown email has no row.
	for action, want := range map[string]int{"staff.create": 1, "staff.totp_enrol": 1, "staff.login_failed": 3} {
		if n := h.count(t, "SELECT count(*) FROM audit_log WHERE action = $1 AND resource_id = $2", action, st.ID.String()); n != want {
			t.Errorf("%s audit rows = %d, want %d", action, n, want)
		}
	}
	if n := h.count(t, "SELECT count(*) FROM audit_log WHERE action = 'staff.login' AND actor_id = $1", st.ID.String()); n != 2 {
		t.Errorf("staff.login audit rows = %d, want 2", n)
	}
}

func TestFiveWrongCodesEndTheChallenge(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	ctx := t.Context()
	_, secret := h.member(t, "Tunde Okafor", "tunde@nem.bank", RoleFinance)

	ch, err := h.svc.Login(ctx, "tunde@nem.bank", staffPassword)
	if err != nil {
		t.Fatal(err)
	}
	for range maxTOTPAttempts {
		_, err := h.svc.VerifyTOTP(ctx, ch.ID, "123456")
		wantProblem(t, err, ErrInvalidTOTP)
	}
	_, err = h.svc.VerifyTOTP(ctx, ch.ID, h.code(secret))
	wantProblem(t, err, ErrTOTPExhausted)
	_, err = h.svc.VerifyTOTP(ctx, ch.ID, h.code(secret))
	wantProblem(t, err, ErrChallengeExpired)

	// A challenge also dies after five minutes.
	late, err := h.svc.Login(ctx, "tunde@nem.bank", staffPassword)
	if err != nil {
		t.Fatal(err)
	}
	h.clock.Advance(challengeTTL)
	_, err = h.svc.VerifyTOTP(ctx, late.ID, h.code(secret))
	wantProblem(t, err, ErrChallengeExpired)
	_, err = h.svc.VerifyTOTP(ctx, uuid.Must(uuid.NewV7()), h.code(secret))
	wantProblem(t, err, ErrChallengeExpired)
}

func TestConsoleSessionsEndOnLogoutExpiryAndDisabling(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	ctx := t.Context()
	st, secret := h.member(t, "Ifeoma Adeyemi", "ifeoma@nem.bank", RoleAdmin, RoleFinance)

	login := func() string {
		ch, err := h.svc.Login(ctx, "ifeoma@nem.bank", staffPassword)
		if err != nil {
			t.Fatal(err)
		}
		sess, err := h.svc.VerifyTOTP(ctx, ch.ID, h.code(secret))
		if err != nil {
			t.Fatal(err)
		}
		h.clock.Advance(30 * time.Second)
		return sess.AccessToken
	}

	tok := login()
	authed, err := h.svc.Authenticate(ctx, tok)
	if err != nil {
		t.Fatal(err)
	}
	p, _ := PrincipalFrom(authed)
	if p.StaffID != st.ID || !p.HasAny(RoleFinance) || p.HasAny(RoleSupport) {
		t.Fatalf("principal = %+v", p)
	}
	if err := h.svc.Logout(authed); err != nil {
		t.Fatal(err)
	}
	_, err = h.svc.Authenticate(ctx, tok)
	wantProblem(t, err, ErrSessionEnded)

	// The 8-hour session has no refresh: at 8 hours it is over.
	tok = login()
	h.clock.Advance(sessionTTL)
	if _, err := h.svc.Authenticate(ctx, tok); err == nil {
		t.Fatal("an 8-hour-old console token still works")
	}

	// Disabling the account ends its live sessions at once.
	tok = login()
	if _, err := h.svc.pool.Exec(ctx, "UPDATE staff SET disabled_at = now() WHERE id = $1", st.ID); err != nil {
		t.Fatal(err)
	}
	_, err = h.svc.Authenticate(ctx, tok)
	wantProblem(t, err, ErrSessionEnded)
	_, err = h.svc.Login(ctx, "ifeoma@nem.bank", staffPassword)
	wantProblem(t, err, ErrInvalidCredentials)

	// A token from another key (another realm, or a forgery) is refused.
	other, err := newTokenSigner([]byte("another-signing-seed-0123456789a"))
	if err != nil {
		t.Fatal(err)
	}
	forged, err := other.sign(st.ID, uuid.Must(uuid.NewV7()), h.clock.Now(), h.clock.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.Authenticate(ctx, forged); err == nil {
		t.Fatal("a token signed with another key was accepted")
	}
}

func TestCreateStaffRefusesWeakOrIncompleteAccounts(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	for name, in := range map[string]StaffInput{
		"no role":      {Name: "A", Email: "a@nem.bank", Password: staffPassword},
		"unknown role": {Name: "A", Email: "a@nem.bank", Password: staffPassword, Roles: []Role{"root"}},
		"short":        {Name: "A", Email: "a@nem.bank", Password: "Short-Pw-1", Roles: []Role{RoleAdmin}},
		"breached":     {Name: "A", Email: "a@nem.bank", Password: "Password1234!", Roles: []Role{RoleAdmin}},
	} {
		if _, err := h.svc.CreateStaff(t.Context(), in); err == nil {
			t.Errorf("%s: account created", name)
		}
	}
	h.member(t, "Chidi Eze", "chidi@nem.bank", RoleSupport)
	if _, err := h.svc.CreateStaff(t.Context(), StaffInput{Name: "Chidi Two", Email: "CHIDI@nem.bank", Password: staffPassword, Roles: []Role{RoleSupport}}); err == nil {
		t.Error("a second account with the same email was created")
	}
}
