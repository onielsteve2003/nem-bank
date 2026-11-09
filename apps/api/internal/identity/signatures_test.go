package identity

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// The three request-signature problems share a code and status, so tests tell them
// apart by their detail.
func wantSignatureProblem(t *testing.T, err error, want *problem.Error) {
	t.Helper()
	var got *problem.Error
	if !errors.As(err, &got) || got.Code != want.Code || got.Status != want.Status || got.Detail != want.Detail {
		t.Fatalf("err = %v, want %s %q", err, want.Code, want.Detail)
	}
}

// signedBy builds a request signed by phone(n), as the app's HTTP client signs.
func signedBy(n byte, device uuid.UUID, at time.Time, nonce, body string) SignedRequest {
	r := SignedRequest{
		DeviceID: device, Timestamp: at.UTC().Format("2006-01-02T15:04:05.000Z07:00"), Nonce: nonce,
		Method: "post", Target: "/v1/transfers?dry_run=false", Body: []byte(body),
	}
	r.Signature = deviceSign(n, CanonicalPayload(r))
	return r
}

func (h *harness) authed(t *testing.T, res AuthResult) context.Context {
	t.Helper()
	ctx, err := h.svc.Authenticate(t.Context(), res.AccessToken)
	if err != nil {
		t.Fatal(err)
	}
	return ctx
}

func TestCanonicalPayloadMatchesTheApp(t *testing.T) {
	t.Parallel()
	// The request in apps/mobile/src/lib/deviceKey.test.ts (signingPayload).
	got := CanonicalPayload(SignedRequest{
		Method: "post", Target: "/v1/transfers?dry_run=false", Timestamp: "2026-10-19T12:00:00Z",
		Nonce: "n1", Body: []byte(`{"amount":"100"}`),
	})
	want := "POST\n/v1/transfers?dry_run=false\n2026-10-19T12:00:00Z\nn1\n" +
		"1614556ae34e0fff0014467eecbca7ddf0be3de3a92ee104b02d56dbb2bc86dc"
	if got != want {
		t.Fatalf("payload =\n%s\nwant\n%s", got, want)
	}
}

func TestSignedRequestsAreAcceptedOnceInsideTheWindow(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	res := h.signedUp(t, "tolu@example.com", "+2348031234567")
	ctx := h.authed(t, res)
	now := h.clock.Now()
	body := `{"amount":{"amount_minor":"150000","currency":"NGN"}}`

	good := signedBy(1, res.Device.ID, now.Add(-time.Minute), "nonce-0000000001", body)
	if err := h.svc.VerifyRequestSignature(ctx, good); err != nil {
		t.Fatalf("good signature: %v", err)
	}
	// The same signed request again, byte for byte: a replay.
	wantSignatureProblem(t, h.svc.VerifyRequestSignature(ctx, good), ErrSignatureReplayed)

	tampered := signedBy(1, res.Device.ID, now, "nonce-0000000002", body)
	tampered.Body = []byte(`{"amount":{"amount_minor":"950000","currency":"NGN"}}`)
	wrongKey := signedBy(2, res.Device.ID, now, "nonce-0000000003", body)
	otherPath := signedBy(1, res.Device.ID, now, "nonce-0000000004", body)
	otherPath.Target = "/v1/fx/conversions"
	otherDevice := signedBy(1, uuid.Must(uuid.NewV7()), now, "nonce-0000000005", body)
	badBase64 := signedBy(1, res.Device.ID, now, "nonce-0000000006", body)
	badBase64.Signature = "not+base64url"
	for name, r := range map[string]SignedRequest{
		"body changed": tampered, "another key": wrongKey, "another path": otherPath,
		"another device id": otherDevice, "not base64url": badBase64,
	} {
		t.Run(name, func(t *testing.T) {
			wantSignatureProblem(t, h.svc.VerifyRequestSignature(ctx, r), ErrRequestSignature)
		})
	}

	for name, r := range map[string]SignedRequest{
		"too old":    signedBy(1, res.Device.ID, now.Add(-6*time.Minute), "nonce-0000000007", body),
		"too far on": signedBy(1, res.Device.ID, now.Add(6*time.Minute), "nonce-0000000008", body),
	} {
		t.Run(name, func(t *testing.T) {
			wantSignatureProblem(t, h.svc.VerifyRequestSignature(ctx, r), ErrSignatureStale)
		})
	}
	unparsable := signedBy(1, res.Device.ID, now, "nonce-0000000009", body)
	unparsable.Timestamp = "yesterday"
	wantSignatureProblem(t, h.svc.VerifyRequestSignature(ctx, unparsable), ErrSignatureStale)

	// Bad signatures never record their nonce, so the real request still goes through.
	if n := count(t, h, `SELECT count(*) FROM signed_request_nonces`); n != 1 {
		t.Fatalf("nonces stored = %d, want 1", n)
	}
	retry := signedBy(1, res.Device.ID, now, "nonce-0000000002", body)
	if err := h.svc.VerifyRequestSignature(ctx, retry); err != nil {
		t.Fatalf("nonce of a refused request: %v", err)
	}

	// Once the first timestamp leaves the window, its nonce row is cleared on the next
	// signature; the window alone refuses the old request.
	h.clock.Advance(5 * time.Minute)
	fresh := signedBy(1, res.Device.ID, h.clock.Now(), "nonce-0000000010", body)
	if err := h.svc.VerifyRequestSignature(ctx, fresh); err != nil {
		t.Fatal(err)
	}
	if n := count(t, h, `SELECT count(*) FROM signed_request_nonces WHERE nonce = 'nonce-0000000001'`); n != 0 {
		t.Fatalf("expired nonce kept")
	}
	wantSignatureProblem(t, h.svc.VerifyRequestSignature(ctx, good), ErrSignatureStale)
}

func TestARevokedDeviceCannotSign(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	res := h.signedUp(t, "tolu@example.com", "+2348031234567")
	ctx := h.authed(t, res)
	if _, err := h.svc.pool.Exec(t.Context(), `UPDATE devices SET revoked_at = now() WHERE id = $1`, res.Device.ID); err != nil {
		t.Fatal(err)
	}
	r := signedBy(1, res.Device.ID, h.clock.Now(), "nonce-0000000001", "{}")
	wantSignatureProblem(t, h.svc.VerifyRequestSignature(ctx, r), ErrRequestSignature)
}

func TestQuickLoginWithTheDeviceKey(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	res := h.signedUp(t, "tolu@example.com", "+2348031234567")
	ctx := t.Context()
	device := res.Device.ID

	c, err := h.svc.CreateDeviceChallenge(ctx, device)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Nonce) != 32 || c.ExpiresAt.Sub(h.clock.Now()) != 2*time.Minute {
		t.Fatalf("challenge = %+v", c)
	}
	in, err := h.svc.LoginWithDevice(ctx, device, c.ID, deviceSign(1, c.Nonce))
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if in.User.ID != res.User.ID || in.Device.ID != device || in.AccessToken == "" {
		t.Fatalf("session = %+v", in)
	}
	// One login per device: the sign-up session was replaced.
	if _, err := h.svc.Authenticate(ctx, res.AccessToken); !errors.Is(err, ErrSessionRevoked) {
		t.Fatalf("old session: %v", err)
	}
	// A challenge works once.
	_, err = h.svc.LoginWithDevice(ctx, device, c.ID, deviceSign(1, c.Nonce))
	wantProblem(t, err, ErrDeviceLogin)

	// A wrong signature spends the challenge too.
	c2, _ := h.svc.CreateDeviceChallenge(ctx, device)
	_, err = h.svc.LoginWithDevice(ctx, device, c2.ID, deviceSign(2, c2.Nonce))
	wantProblem(t, err, ErrDeviceLogin)
	_, err = h.svc.LoginWithDevice(ctx, device, c2.ID, deviceSign(1, c2.Nonce))
	wantProblem(t, err, ErrDeviceLogin)

	// Expired, unknown and mismatched challenges all look the same.
	c3, _ := h.svc.CreateDeviceChallenge(ctx, device)
	_, err = h.svc.LoginWithDevice(ctx, uuid.Must(uuid.NewV7()), c3.ID, deviceSign(1, c3.Nonce))
	wantProblem(t, err, ErrDeviceLogin)
	c4, _ := h.svc.CreateDeviceChallenge(ctx, device)
	h.clock.Advance(2 * time.Minute)
	_, err = h.svc.LoginWithDevice(ctx, device, c4.ID, deviceSign(1, c4.Nonce))
	wantProblem(t, err, ErrDeviceLogin)
	_, err = h.svc.LoginWithDevice(ctx, device, uuid.Must(uuid.NewV7()), deviceSign(1, "x"))
	wantProblem(t, err, ErrDeviceLogin)

	// A revoked or unknown device gets no challenge.
	_, err = h.svc.CreateDeviceChallenge(ctx, uuid.Must(uuid.NewV7()))
	wantProblem(t, err, ErrDeviceUnknown)
}
