package httpserver

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newTestRouter(t *testing.T, logs io.Writer) http.Handler {
	t.Helper()
	if logs == nil {
		logs = io.Discard
	}
	return NewRouter(Options{
		Version:     "test-1",
		Logger:      slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
		CORSOrigins: []string{"https://app.example"},
	})
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
	var got Health
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
	var p problem
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if p.Code != "not_found" || p.RequestID != "abc-123" || p.Status != http.StatusNotFound {
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
