package httpserver

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/idempotency"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

// signedPost sends a money-moving POST signed the way the app's HTTP client signs it.
func signedPost(t *testing.T, h http.Handler, key ed25519.PrivateKey, deviceID uuid.UUID, token, target, body, nonce string) *httptest.ResponseRecorder {
	t.Helper()
	return signedPostKey(t, h, key, deviceID, token, target, body, nonce, uuid.Must(uuid.NewV7()).String())
}

// signedPostKey is signedPost with a chosen Idempotency-Key, to replay a double tap.
func signedPostKey(t *testing.T, h http.Handler, key ed25519.PrivateKey, deviceID uuid.UUID, token, target, body, nonce, idemKey string) *httptest.ResponseRecorder {
	t.Helper()
	return signedRequest(t, h, http.MethodPost, key, deviceID, token, target, body, nonce, idemKey)
}

// signedRequest signs any method the way the app does.
func signedRequest(t *testing.T, h http.Handler, method string, key ed25519.PrivateKey, deviceID uuid.UUID, token, target, body, nonce, idemKey string) *httptest.ResponseRecorder {
	t.Helper()
	ts := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	sum := sha256.Sum256([]byte(body))
	payload := strings.Join([]string{method, target, ts, nonce, hex.EncodeToString(sum[:])}, "\n")
	req := httptest.NewRequestWithContext(t.Context(), method, target, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Idempotency-Key", idemKey)
	req.Header.Set("X-Device-Id", deviceID.String())
	req.Header.Set("X-Device-Signature", base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, []byte(payload))))
	req.Header.Set("X-Signature-Timestamp", ts)
	req.Header.Set("X-Nonce", nonce)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestMoneyRequestsNeedTheDeviceSignatureAndQuickLoginWorks(t *testing.T) {
	t.Parallel()

	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	mail := &lastMail{}
	pool := testdb.New(t)
	svc, err := identity.NewService(identity.Config{
		Pool: pool, Mailer: mail, Logger: quiet,
		OTPKey:     []byte("0123456789abcdef0123456789abcdef"),
		SigningKey: []byte("fedcba9876543210fedcba9876543210"),
		Hasher:     identity.NewHasher(identity.Argon2Params{MemoryKiB: 64, Time: 1, Threads: 1}, 2),
	})
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewRouter(Options{Version: "e2e", Logger: quiet, Identity: identity.NewAPI(svc), Authenticator: svc, Signatures: svc,
		Idempotency: idempotency.NewStore(pool)})
	if err != nil {
		t.Fatal(err)
	}

	key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, ed25519.SeedSize))
	pub := base64.RawURLEncoding.EncodeToString(key.Public().(ed25519.PublicKey)) //nolint:forcetypeassert // always ed25519
	started := call[api.SignupStarted](t, h, http.MethodPost, "/v1/auth/signup", "", map[string]any{
		"first_name": "Tolu", "last_name": "Adeyemi", "email": "tolu@example.com", "phone": "+2348031234567",
		"date_of_birth": "1996-04-12",
		"consent":       map[string]string{"terms_version": "2026-10", "privacy_version": "2026-10", "accepted_at": "2026-11-01T10:00:00Z"},
	}, http.StatusCreated)
	verified := call[api.OtpVerified](t, h, http.MethodPost, "/v1/auth/otp/verify", "",
		map[string]string{"challenge_id": started.Otp.ChallengeId.String(), "code": mail.code()}, http.StatusOK)
	session := call[api.AuthSession](t, h, http.MethodPost, "/v1/auth/signup/complete", "", map[string]any{
		"signup_id": started.SignupId, "verification_token": verified.VerificationToken,
		"password": "Kitchen-Mango-River-7",
		"device":   map[string]any{"name": "Tolu's iPhone", "platform": "ios", "public_key": pub},
	}, http.StatusCreated)

	// Key order and spacing differ from what validation re-encodes: the hash must be of
	// these exact bytes.
	body := `{ "amount": {"currency":"NGN","amount_minor":"150000"}, "destination": {"kind":"nem","account_number":"0123456789"},` +
		` "source_account_id": "` + uuid.Must(uuid.NewV7()).String() + `" }`
	// Transfers arrive with M25; until then a verified request reaches the 501 stub.
	if rec := signedPost(t, h, key, session.Device.Id, session.AccessToken, "/v1/transfers", body, "nonce-e2e-000001"); rec.Code != http.StatusNotImplemented {
		t.Fatalf("signed transfer = %d: %s", rec.Code, rec.Body)
	}
	rec := signedPost(t, h, key, session.Device.Id, session.AccessToken, "/v1/transfers", body, "nonce-e2e-000001")
	if p := decodeProblem(t, rec); rec.Code != http.StatusForbidden || p.Code != "invalid_signature" {
		t.Fatalf("replay = %d %+v", rec.Code, p)
	}
	other := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{8}, ed25519.SeedSize))
	rec = signedPost(t, h, other, session.Device.Id, session.AccessToken, "/v1/transfers", body, "nonce-e2e-000002")
	if rec.Code != http.StatusForbidden || rec.Header().Get("WWW-Authenticate") != "" {
		t.Fatalf("another key = %d", rec.Code)
	}

	// Biometric quick login: sign the server's nonce with the same key.
	ch := call[api.DeviceChallenge](t, h, http.MethodPost, "/v1/auth/device-challenge", "",
		map[string]string{"device_id": session.Device.Id.String()}, http.StatusCreated)
	quick := call[api.AuthSession](t, h, http.MethodPost, "/v1/auth/login/device", "", map[string]string{
		"device_id": session.Device.Id.String(), "challenge_id": ch.ChallengeId.String(),
		"signature": base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, []byte(ch.Nonce))),
	}, http.StatusOK)
	if quick.User.Id != session.User.Id || quick.Device.Id != session.Device.Id {
		t.Fatalf("quick login = %+v", quick)
	}
	p := call[api.Problem](t, h, http.MethodPost, "/v1/auth/login/device", "", map[string]string{
		"device_id": session.Device.Id.String(), "challenge_id": ch.ChallengeId.String(),
		"signature": base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, []byte(ch.Nonce))),
	}, http.StatusUnauthorized)
	if p.Code != "invalid_signature" {
		t.Fatalf("challenge reused: %+v", p)
	}
}
