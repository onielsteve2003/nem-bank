package httpserver

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
)

func newTestRouter(t *testing.T, logs io.Writer) http.Handler {
	t.Helper()
	if logs == nil {
		logs = io.Discard
	}
	r, err := NewRouter(Options{
		Version:     "test-1",
		Logger:      slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
		CORSOrigins: []string{"https://app.example"},
	})
	if err != nil {
		t.Fatalf("new router: %v", err)
	}
	return r
}

func do(t *testing.T, h http.Handler, method, path string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequestWithContext(t.Context(), method, path, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestHealthReportsOKAndVersion(t *testing.T) {
	t.Parallel()

	rec := do(t, newTestRouter(t, nil), http.MethodGet, "/v1/health", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var got api.Health
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if got.Status != "ok" || got.Version != "test-1" || got.Time.IsZero() {
		t.Fatalf("unexpected body: %+v", got)
	}
}

func TestUnknownRouteIsAProblemWithTheRequestID(t *testing.T) {
	t.Parallel()

	rec := do(t, newTestRouter(t, nil), http.MethodGet, "/v1/nope", map[string]string{HeaderRequestID: "abc-123"})
	if rec.Code != http.StatusNotFound || rec.Header().Get("Content-Type") != "application/problem+json" {
		t.Fatalf("got %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	p := decodeProblem(t, rec)
	if p.Code != "not_found" || p.RequestId == nil || *p.RequestId != "abc-123" || p.Status != http.StatusNotFound {
		t.Fatalf("unexpected problem: %+v", p)
	}
}

func TestAccessLogUsesTheRouteTemplateNotTheQuery(t *testing.T) {
	t.Parallel()

	var logs bytes.Buffer
	do(t, newTestRouter(t, &logs), http.MethodGet, "/v1/health?email=ada@example.com", nil)
	if bytes.Contains(logs.Bytes(), []byte("ada@example.com")) {
		t.Fatalf("query string leaked into logs: %s", logs.String())
	}
	if !bytes.Contains(logs.Bytes(), []byte(`"route":"/v1/health"`)) {
		t.Fatalf("route missing from logs: %s", logs.String())
	}
}

func decodeProblem(t *testing.T, rec *httptest.ResponseRecorder) api.Problem {
	t.Helper()
	if ct := rec.Header().Get("Content-Type"); ct != "application/problem+json" {
		t.Fatalf("content type = %q, want application/problem+json", ct)
	}
	var p api.Problem
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatalf("decode problem: %v", err)
	}
	return p
}

func TestAKnownPathWithTheWrongMethodIsA405(t *testing.T) {
	t.Parallel()

	rec := do(t, newTestRouter(t, nil), http.MethodDelete, "/v1/health", nil)
	if rec.Code != http.StatusMethodNotAllowed || !strings.Contains(rec.Header().Get("Allow"), http.MethodGet) {
		t.Fatalf("got %d Allow=%q", rec.Code, rec.Header().Get("Allow"))
	}
	if p := decodeProblem(t, rec); p.Code != "method_not_allowed" {
		t.Fatalf("unexpected problem: %+v", p)
	}
}

func TestNotImplementedOperationsUseTheProblemType(t *testing.T) {
	t.Parallel()

	rec := do(t, newTestRouter(t, nil), http.MethodGet, "/v1/accounts", nil)
	p := decodeProblem(t, rec)
	if rec.Code != http.StatusNotImplemented || p.Type != "https://nem.bank/problems/not_implemented" {
		t.Fatalf("got %d %+v", rec.Code, p)
	}
}
