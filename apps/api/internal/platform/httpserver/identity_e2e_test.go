package httpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sync"
	"testing"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/mailer"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

type lastMail struct {
	mu   sync.Mutex
	text string
}

func (m *lastMail) Send(_ context.Context, msg mailer.Message) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.text = msg.Text
	return nil
}

func (m *lastMail) code() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return regexp.MustCompile(`\d{6}`).FindString(m.text)
}

func call[T any](t *testing.T, h http.Handler, method, path, token string, body any, wantStatus int) T {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequestWithContext(t.Context(), method, path, &buf)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != wantStatus {
		t.Fatalf("%s %s = %d, want %d: %s", method, path, rec.Code, wantStatus, rec.Body)
	}
	var out T
	if rec.Body.Len() > 0 {
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode %s: %v", path, err)
		}
	}
	return out
}

func TestSignUpThroughTheAPIAndUseTheSession(t *testing.T) {
	t.Parallel()

	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	mail := &lastMail{}
	svc, err := identity.NewService(identity.Config{
		Pool: testdb.New(t), Mailer: mail, Logger: quiet,
		OTPKey:     []byte("0123456789abcdef0123456789abcdef"),
		SigningKey: []byte("fedcba9876543210fedcba9876543210"),
		Hasher:     identity.NewHasher(identity.Argon2Params{MemoryKiB: 64, Time: 1, Threads: 1}, 2),
	})
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewRouter(Options{Version: "e2e", Logger: quiet, Identity: identity.NewAPI(svc), Authenticator: svc})
	if err != nil {
		t.Fatal(err)
	}

	started := call[api.SignupStarted](t, h, http.MethodPost, "/v1/auth/signup", "", map[string]any{
		"first_name": "Tolu", "last_name": "Adeyemi", "email": "tolu@example.com", "phone": "+2348031234567",
		"date_of_birth": "1996-04-12",
		"consent":       map[string]string{"terms_version": "2026-10", "privacy_version": "2026-10", "accepted_at": "2026-11-01T10:00:00Z"},
	}, http.StatusCreated)
	if started.Otp.DestinationMasked != "t***@example.com" {
		t.Fatalf("otp = %+v", started.Otp)
	}
	verified := call[api.OtpVerified](t, h, http.MethodPost, "/v1/auth/otp/verify", "",
		map[string]string{"challenge_id": started.Otp.ChallengeId.String(), "code": mail.code()}, http.StatusOK)

	session := call[api.AuthSession](t, h, http.MethodPost, "/v1/auth/signup/complete", "", map[string]any{
		"signup_id": started.SignupId, "verification_token": verified.VerificationToken,
		"password": "Kitchen-Mango-River-7",
		"device":   map[string]any{"name": "Tolu's iPhone", "platform": "ios", "public_key": "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"},
	}, http.StatusCreated)
	if session.TokenType != api.Bearer || !session.Device.Current || !session.Device.Trusted {
		t.Fatalf("session = %+v", session)
	}

	me := call[api.User](t, h, http.MethodGet, "/v1/users/me", session.AccessToken, nil, http.StatusOK)
	if me.Email != "tolu@example.com" || me.KycTier != 1 {
		t.Fatalf("me = %+v", me)
	}
	call[api.Problem](t, h, http.MethodGet, "/v1/users/me", "", nil, http.StatusUnauthorized)

	rotated := call[api.AuthSession](t, h, http.MethodPost, "/v1/auth/refresh", "",
		map[string]string{"refresh_token": session.RefreshToken}, http.StatusOK)
	devices := call[api.DeviceList](t, h, http.MethodGet, "/v1/devices", rotated.AccessToken, nil, http.StatusOK)
	if len(devices.Data) != 1 || !devices.Data[0].Current {
		t.Fatalf("devices = %+v", devices)
	}

	call[struct{}](t, h, http.MethodPut, "/v1/users/me/pin", rotated.AccessToken, map[string]string{"pin": "2580"}, http.StatusNoContent)
	pin := call[api.PinVerification](t, h, http.MethodPost, "/v1/users/me/pin/verify", rotated.AccessToken,
		map[string]string{"pin": "1357"}, http.StatusOK)
	if pin.Valid || pin.AttemptsRemaining != 4 {
		t.Fatalf("wrong pin = %+v", pin)
	}
	if me := call[api.User](t, h, http.MethodGet, "/v1/users/me", rotated.AccessToken, nil, http.StatusOK); !me.HasPin {
		t.Fatal("has_pin is false after setting the PIN")
	}
	// The contract requires X-Step-Up-Token on a PIN reset.
	pReset := call[api.Problem](t, h, http.MethodPost, "/v1/users/me/pin/reset", rotated.AccessToken,
		map[string]string{"pin": "4815"}, http.StatusBadRequest)
	if pReset.Code != "validation_failed" { // no X-Step-Up-Token header: the contract requires it
		t.Fatalf("reset without header: %+v", pReset)
	}

	call[struct{}](t, h, http.MethodPost, "/v1/auth/logout", rotated.AccessToken, nil, http.StatusNoContent)
	p := call[api.Problem](t, h, http.MethodGet, "/v1/users/me", rotated.AccessToken, nil, http.StatusUnauthorized)
	if p.Code != "session_revoked" {
		t.Fatalf("after logout: %+v", p)
	}
}
