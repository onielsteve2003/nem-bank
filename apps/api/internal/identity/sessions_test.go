package identity

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

var testSeed = []byte("fedcba9876543210fedcba9876543210")

// phone is a device registration with a distinct, deterministic Ed25519 key.
func phone(n byte) DeviceRegistration {
	seed := make([]byte, ed25519.SeedSize)
	seed[0] = n
	pub := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey) //nolint:forcetypeassert // always ed25519
	return DeviceRegistration{Name: "Tolu's iPhone", Platform: "ios", PublicKey: base64.RawURLEncoding.EncodeToString(pub), HardwareBacked: true}
}

// signedUp runs the whole sign-up and returns its session.
func (h *harness) signedUp(t *testing.T, email, tel string) AuthResult {
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
	res, err := h.svc.CompleteSignup(ctx, started.SignupID, v.Token, strongPassword, phone(1))
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	return res
}

func count(t *testing.T, h *harness, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := h.svc.pool.QueryRow(t.Context(), sql, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	return n
}

func TestLoginOnANewDeviceStartsTheCoolOffAndAlerts(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	ctx := t.Context()
	first := h.signedUp(t, "tolu@example.com", "+2348031234567")

	ipad := phone(2)
	res, err := h.svc.Login(ctx, LoginInput{Identifier: "08031234567", Password: strongPassword, Device: &ipad})
	if err != nil {
		t.Fatalf("login by local phone number: %v", err)
	}
	if res.Device.ID == first.Device.ID || res.Device.CoolOffUntil == nil ||
		res.Device.CoolOffUntil.Sub(h.clock.Now()) != 24*time.Hour {
		t.Fatalf("new device = %+v", res.Device)
	}
	if n := count(t, h, "SELECT count(*) FROM outbox_events WHERE topic = 'identity.device_bound'"); n != 1 {
		t.Fatalf("device_bound events = %d, want 1", n)
	}

	// The trusted first device logs in by id, with no new binding or alert.
	again, err := h.svc.Login(ctx, LoginInput{Identifier: "TOLU@example.com", Password: strongPassword, DeviceID: &first.Device.ID})
	if err != nil || again.Device.ID != first.Device.ID {
		t.Fatalf("trusted login: %v", err)
	}
	// One session per device: the sign-up session on that device was replaced.
	if _, err := h.svc.Authenticate(ctx, first.AccessToken); !errors.Is(err, ErrSessionRevoked) {
		t.Fatalf("replaced session: err = %v, want session_revoked", err)
	}
}

func TestLoginFailuresAllLookTheSame(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	ctx := t.Context()
	h.signedUp(t, "tolu@example.com", "+2348031234567")
	stranger := uuid.Must(uuid.NewV7())
	d := phone(2)

	for name, in := range map[string]LoginInput{
		"wrong password":  {Identifier: "tolu@example.com", Password: "Wrong-Password-99", Device: &d},
		"unknown email":   {Identifier: "nobody@example.com", Password: strongPassword, Device: &d},
		"unknown phone":   {Identifier: "+2348090000000", Password: strongPassword, Device: &d},
		"unbound device":  {Identifier: "tolu@example.com", Password: strongPassword, DeviceID: &stranger},
		"device required": {Identifier: "tolu@example.com", Password: strongPassword},
	} {
		_, err := h.svc.Login(ctx, in)
		want := ErrInvalidCredentials
		switch name {
		case "unbound device":
			want = ErrDeviceNotBound
		case "device required":
			want = ErrDeviceRequired
		}
		if !errors.Is(err, want) {
			t.Errorf("%s: err = %v, want %s", name, err, want.Code)
		}
	}
}

func TestRefreshRotatesAndReuseRevokesTheFamily(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	ctx := t.Context()
	s := h.signedUp(t, "tolu@example.com", "+2348031234567")

	next, err := h.svc.Refresh(ctx, s.RefreshToken)
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if next.RefreshToken == s.RefreshToken || !strings.HasPrefix(next.RefreshToken, "nrt_") {
		t.Fatalf("refresh token did not rotate: %q", next.RefreshToken)
	}
	if _, err := h.svc.Authenticate(ctx, next.AccessToken); err != nil {
		t.Fatalf("new access token: %v", err)
	}

	// The old token comes back: it was copied. Both holders lose the session.
	_, err = h.svc.Refresh(ctx, s.RefreshToken)
	wantProblem(t, err, ErrInvalidToken)
	_, err = h.svc.Refresh(ctx, next.RefreshToken)
	wantProblem(t, err, ErrInvalidToken)
	if _, err := h.svc.Authenticate(ctx, next.AccessToken); !errors.Is(err, ErrSessionRevoked) {
		t.Fatalf("access after reuse: err = %v, want session_revoked", err)
	}
	if n := count(t, h, "SELECT count(*) FROM sessions WHERE revoke_reason = 'token_reuse'"); n != 1 {
		t.Fatalf("sessions revoked for reuse = %d, want 1", n)
	}
	_, err = h.svc.Refresh(ctx, "nrt_never-issued")
	wantProblem(t, err, ErrInvalidToken)
}

func TestRefreshTokensExpire(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	s := h.signedUp(t, "tolu@example.com", "+2348031234567")

	h.clock.Advance(30*24*time.Hour + time.Second)
	_, err := h.svc.Refresh(t.Context(), s.RefreshToken)
	wantProblem(t, err, ErrInvalidToken)
}

func TestAccessTokensAreCheckedStrictly(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	ctx := t.Context()
	s := h.signedUp(t, "tolu@example.com", "+2348031234567")

	authed, err := h.svc.Authenticate(ctx, s.AccessToken)
	if err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	if p, ok := PrincipalFrom(authed); !ok || p.UserID != s.User.ID || p.DeviceID != s.Device.ID {
		t.Fatalf("principal = %+v", p)
	}

	parts := strings.Split(s.AccessToken, ".")
	none := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`)) + "." + parts[1] + "."
	hs := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"sub": s.User.ID.String()})
	hsSigned, _ := hs.SignedString([]byte("guess"))
	other, _ := newTokenSigner([]byte("another-seed-another-seed-32byte"))
	forged, _, _ := other.sign(Principal{UserID: s.User.ID, SessionID: uuid.New(), DeviceID: s.Device.ID}, h.clock.Now())
	for name, tok := range map[string]string{
		"tampered payload": parts[0] + "." + parts[1] + "x." + parts[2],
		"alg none":         none,
		"hs256":            hsSigned,
		"other key":        forged,
		"garbage":          "not-a-jwt",
	} {
		if _, err := h.svc.Authenticate(ctx, tok); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}

	h.clock.Advance(10 * time.Minute)
	if _, err := h.svc.Authenticate(ctx, s.AccessToken); err == nil {
		t.Fatal("expired access token accepted")
	}
}

func TestLogoutAndRevocationEndSessionsAtOnce(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	ctx := t.Context()
	s := h.signedUp(t, "tolu@example.com", "+2348031234567")
	ipad := phone(2)
	second, err := h.svc.Login(ctx, LoginInput{Identifier: "tolu@example.com", Password: strongPassword, Device: &ipad})
	if err != nil {
		t.Fatal(err)
	}
	phoneCtx, _ := h.svc.Authenticate(ctx, s.AccessToken)

	devices, _, err := h.svc.Devices(phoneCtx)
	if err != nil || len(devices) != 2 {
		t.Fatalf("devices = %d, err %v", len(devices), err)
	}
	sessions, p, err := h.svc.Sessions(phoneCtx)
	if err != nil || len(sessions) != 2 || p.SessionID == uuid.Nil {
		t.Fatalf("sessions = %d, err %v", len(sessions), err)
	}

	// The phone revokes the iPad: its session ends now, not in 10 minutes.
	if err := h.svc.RevokeDevice(phoneCtx, second.Device.ID); err != nil {
		t.Fatalf("revoke device: %v", err)
	}
	if _, err := h.svc.Authenticate(ctx, second.AccessToken); !errors.Is(err, ErrSessionRevoked) {
		t.Fatalf("revoked device's token: err = %v", err)
	}
	wantProblem(t, h.svc.RevokeDevice(phoneCtx, second.Device.ID), ErrDeviceNotFound)
	wantProblem(t, h.svc.RevokeDevice(phoneCtx, s.Device.ID), ErrRevokeCurrent)
	wantProblem(t, h.svc.RevokeSession(phoneCtx, uuid.Must(uuid.NewV7())), ErrSessionNotFound)

	if err := h.svc.Logout(phoneCtx, false); err != nil {
		t.Fatalf("logout: %v", err)
	}
	if _, err := h.svc.Authenticate(ctx, s.AccessToken); !errors.Is(err, ErrSessionRevoked) {
		t.Fatalf("after logout: err = %v", err)
	}
	_, err = h.svc.Refresh(ctx, s.RefreshToken)
	wantProblem(t, err, ErrInvalidToken)
}

func TestADeviceKeyBelongsToOneAccount(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	h.signedUp(t, "tolu@example.com", "+2348031234567") // binds phone(1)

	started, err := h.svc.StartSignup(t.Context(), details("ada@example.com", "+2348031234568"))
	if err != nil {
		t.Fatal(err)
	}
	v, err := h.svc.VerifyCode(t.Context(), started.Challenge.ID, h.inbox.lastCode(t))
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.svc.CompleteSignup(t.Context(), started.SignupID, v.Token, strongPassword, phone(1))
	wantProblem(t, err, ErrDeviceKeyInUse)
}
