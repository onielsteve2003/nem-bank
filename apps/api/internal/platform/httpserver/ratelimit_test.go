package httpserver

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/ratelimit"
)

// customerAuth signs in every bearer token as the customer the token names.
type customerAuth struct{}

func (customerAuth) Authenticate(ctx context.Context, bearer string) (context.Context, error) {
	id, err := uuid.Parse(bearer)
	if err != nil {
		return nil, problem.Unauthorized()
	}
	return identity.WithPrincipal(ctx, identity.Principal{UserID: id, DeviceID: id}), nil
}

// countingVerifier accepts every signature and counts the checks.
type countingVerifier struct{ n atomic.Int32 }

func (v *countingVerifier) VerifyRequestSignature(context.Context, identity.SignedRequest) error {
	v.n.Add(1)
	return nil
}

func limitedRouter(t *testing.T, limits RateLimits, ipHeader string, sig SignatureVerifier) http.Handler {
	t.Helper()
	h, err := NewRouter(Options{
		Version: "test", Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Authenticator: customerAuth{}, Signatures: sig, Idempotency: alwaysRun{}, RateLimits: &limits, ClientIPHeader: ipHeader,
	})
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func perMinute(n int) ratelimit.Rule { return ratelimit.Rule{Limit: n, Window: time.Minute} }

func wantLimited(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	p := decodeProblem(t, rec)
	if rec.Code != http.StatusTooManyRequests || p.Code != "rate_limited" {
		t.Fatalf("got %d %s, want 429 rate_limited", rec.Code, p.Code)
	}
	if secs, err := strconv.Atoi(rec.Header().Get("Retry-After")); err != nil || secs < 1 || secs > 60 {
		t.Fatalf("Retry-After = %q", rec.Header().Get("Retry-After"))
	}
}

func TestEveryAddressHasABudgetThatForwardedHeadersCannotReset(t *testing.T) {
	t.Parallel()
	h := limitedRouter(t, RateLimits{IP: perMinute(2)}, "", nil)
	for i := range 2 {
		if rec := do(t, h, http.MethodGet, "/v1/health", map[string]string{"X-Forwarded-For": "198.51.100." + strconv.Itoa(i)}); rec.Code != http.StatusOK {
			t.Fatalf("request %d = %d", i+1, rec.Code)
		}
	}
	// A caller cannot claim a fresh address: X-Forwarded-For is not trusted.
	wantLimited(t, do(t, h, http.MethodGet, "/v1/health", map[string]string{"X-Forwarded-For": "203.0.113.9"}))
	// Probes are outside the contract routes and never limited.
	if rec := do(t, h, http.MethodGet, LivenessPath, nil); rec.Code != http.StatusOK {
		t.Fatalf("liveness = %d", rec.Code)
	}
}

func TestTheHostsClientAddressHeaderSeparatesCallers(t *testing.T) {
	t.Parallel()
	h := limitedRouter(t, RateLimits{IP: perMinute(1)}, "CF-Connecting-IP", nil)
	for _, ip := range []string{"198.51.100.1", "198.51.100.2"} {
		if rec := do(t, h, http.MethodGet, "/v1/health", map[string]string{"CF-Connecting-IP": ip}); rec.Code != http.StatusOK {
			t.Fatalf("%s = %d", ip, rec.Code)
		}
	}
	wantLimited(t, do(t, h, http.MethodGet, "/v1/health", map[string]string{"CF-Connecting-IP": "198.51.100.1"}))
}

func TestSensitiveRoutesHaveTheirOwnTighterBudget(t *testing.T) {
	t.Parallel()
	h := limitedRouter(t, RateLimits{Routes: map[string]ratelimit.Rule{"POST /v1/auth/login": perMinute(1)}}, "", nil)
	login := func() *httptest.ResponseRecorder {
		req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/v1/auth/login", bytes.NewBufferString(`{}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	if rec := login(); rec.Code != http.StatusBadRequest { // counted even though the body is invalid
		t.Fatalf("first login = %d", rec.Code)
	}
	wantLimited(t, login())
	if rec := do(t, h, http.MethodGet, "/v1/health", nil); rec.Code != http.StatusOK {
		t.Fatalf("another route shares the login budget: %d", rec.Code)
	}
}

func TestEachCustomerHasABudgetAndMoneyRoutesAreCheckedBeforeTheSignature(t *testing.T) {
	t.Parallel()
	sig := &countingVerifier{}
	h := limitedRouter(t, RateLimits{User: perMinute(3), Signed: perMinute(1)}, "", sig)
	tolu, emeka := uuid.Must(uuid.NewV7()).String(), uuid.Must(uuid.NewV7()).String()

	transfer := func(user string) *httptest.ResponseRecorder {
		body := `{"source_account_id":"` + user + `","destination":{"kind":"nem","account_number":"0123456789"},` +
			`"amount":{"amount_minor":"100","currency":"NGN"}}`
		req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/v1/transfers", bytes.NewBufferString(body))
		for k, v := range map[string]string{
			"Content-Type": "application/json", "Authorization": "Bearer " + user,
			"Idempotency-Key": uuid.Must(uuid.NewV7()).String(), "X-Device-Id": user,
			"X-Device-Signature": "c2lnbmF0dXJl", "X-Signature-Timestamp": time.Now().UTC().Format(time.RFC3339),
			"X-Nonce": uuid.Must(uuid.NewV7()).String(),
		} {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	if rec := transfer(tolu); rec.Code != http.StatusNotImplemented {
		t.Fatalf("first transfer = %d: %s", rec.Code, rec.Body)
	}
	wantLimited(t, transfer(tolu))
	if sig.n.Load() != 1 {
		t.Fatalf("signature checks = %d: a limited request was verified", sig.n.Load())
	}
	// Tolu's other calls still have budget (2 of 3 used); then the per-customer cap.
	if rec := do(t, h, http.MethodGet, "/v1/cards", map[string]string{"Authorization": "Bearer " + tolu}); rec.Code != http.StatusNotImplemented {
		t.Fatalf("cards = %d", rec.Code)
	}
	wantLimited(t, do(t, h, http.MethodGet, "/v1/cards", map[string]string{"Authorization": "Bearer " + tolu}))
	// Another customer is unaffected.
	if rec := transfer(emeka); rec.Code != http.StatusNotImplemented {
		t.Fatalf("emeka's transfer = %d", rec.Code)
	}
}
