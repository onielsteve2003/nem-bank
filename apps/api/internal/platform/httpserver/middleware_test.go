package httpserver

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

func TestRequestIDKeepsAWellFormedCallerID(t *testing.T) {
	t.Parallel()

	rec := do(t, newTestRouter(t, nil), http.MethodGet, "/v1/health", map[string]string{HeaderRequestID: "app.req_42"})
	if got := rec.Header().Get(HeaderRequestID); got != "app.req_42" {
		t.Fatalf("X-Request-Id = %q", got)
	}
}

func TestRequestIDReplacesAMissingOrUnsafeID(t *testing.T) {
	t.Parallel()

	for _, in := range []string{"", "has spaces", "line\nbreak", strings.Repeat("a", 129)} {
		rec := do(t, newTestRouter(t, nil), http.MethodGet, "/v1/health", map[string]string{HeaderRequestID: in})
		id, err := uuid.Parse(rec.Header().Get(HeaderRequestID))
		if err != nil || id.Version() != 7 {
			t.Fatalf("input %q: X-Request-Id = %q, want a UUIDv7", in, rec.Header().Get(HeaderRequestID))
		}
	}
}

func TestRecoveryTurnsAPanicIntoA500Problem(t *testing.T) {
	t.Parallel()

	var logs bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&logs, nil))
	r := gin.New()
	r.Use(RequestID(), Recovery(log))
	r.GET("/boom", func(*gin.Context) { panic("kaboom") })

	rec := do(t, r, http.MethodGet, "/boom", map[string]string{HeaderRequestID: "req-9"})
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", rec.Code)
	}
	p := decodeProblem(t, rec)
	if p.Code != "internal_error" || p.RequestId == nil || *p.RequestId != "req-9" {
		t.Fatalf("unexpected problem: %+v", p)
	}
	if strings.Contains(rec.Body.String(), "kaboom") {
		t.Fatal("panic value leaked to the client")
	}
	if !strings.Contains(logs.String(), "kaboom") || !strings.Contains(logs.String(), "stack") {
		t.Fatalf("panic not logged: %s", logs.String())
	}
}

func TestCORS(t *testing.T) {
	t.Parallel()

	h := newTestRouter(t, io.Discard)
	preflight := func(origin string) map[string]string {
		return map[string]string{"Origin": origin, "Access-Control-Request-Method": "POST"}
	}

	t.Run("preflight from an allowed origin", func(t *testing.T) {
		t.Parallel()
		rec := do(t, h, http.MethodOptions, "/v1/transfers", preflight("https://app.example"))
		if rec.Code != http.StatusNoContent ||
			rec.Header().Get("Access-Control-Allow-Origin") != "https://app.example" ||
			!strings.Contains(rec.Header().Get("Access-Control-Allow-Headers"), "Idempotency-Key") ||
			!strings.Contains(rec.Header().Get("Access-Control-Allow-Headers"), "X-Device-Signature") {
			t.Fatalf("got %d %v", rec.Code, rec.Header())
		}
	})

	t.Run("preflight from another origin", func(t *testing.T) {
		t.Parallel()
		rec := do(t, h, http.MethodOptions, "/v1/transfers", preflight("https://evil.example"))
		if rec.Code != http.StatusForbidden || rec.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatalf("got %d %v", rec.Code, rec.Header())
		}
	})

	t.Run("simple request exposes the request ID", func(t *testing.T) {
		t.Parallel()
		rec := do(t, h, http.MethodGet, "/v1/health", map[string]string{"Origin": "https://app.example"})
		if rec.Header().Get("Access-Control-Allow-Origin") != "https://app.example" ||
			rec.Header().Get("Access-Control-Expose-Headers") != HeaderRequestID ||
			rec.Header().Get("Vary") != "Origin" {
			t.Fatalf("headers = %v", rec.Header())
		}
	})

	t.Run("simple request from another origin gets no CORS headers", func(t *testing.T) {
		t.Parallel()
		rec := do(t, h, http.MethodGet, "/v1/health", map[string]string{"Origin": "https://evil.example"})
		if rec.Code != http.StatusOK || rec.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatalf("got %d %v", rec.Code, rec.Header())
		}
	})
}

func TestSecurityHeadersAreOnEveryResponse(t *testing.T) {
	t.Parallel()

	rec := do(t, newTestRouter(t, io.Discard), http.MethodGet, "/v1/health", nil)
	for k, want := range map[string]string{
		"X-Content-Type-Options": "nosniff",
		"Cache-Control":          "no-store",
		"X-Frame-Options":        "DENY",
		"Referrer-Policy":        "no-referrer",
	} {
		if got := rec.Header().Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	if !strings.Contains(rec.Header().Get("Strict-Transport-Security"), "max-age=") ||
		!strings.Contains(rec.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") {
		t.Fatalf("headers = %v", rec.Header())
	}
	// Unknown routes get them too: the middleware runs before routing.
	if do(t, newTestRouter(t, io.Discard), http.MethodGet, "/nope", nil).Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("404 response has no security headers")
	}
}

func TestBodyLimit(t *testing.T) {
	t.Parallel()

	r := gin.New()
	r.Use(RequestID(), BodyLimit())
	r.POST("/echo", func(c *gin.Context) {
		if _, err := io.Copy(io.Discard, c.Request.Body); err != nil {
			c.Status(http.StatusRequestEntityTooLarge)
			return
		}
		c.Status(http.StatusNoContent)
	})
	post := func(contentType string, size int) int {
		req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/echo", bytes.NewReader(make([]byte, size)))
		req.Header.Set("Content-Type", contentType)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec.Code
	}

	if got := post("application/json", 1<<20); got != http.StatusNoContent {
		t.Errorf("1 MiB JSON = %d, want 204", got)
	}
	if got := post("application/json", 1<<20+1); got != http.StatusRequestEntityTooLarge {
		t.Errorf("over 1 MiB JSON = %d, want 413", got)
	}
	if got := post("multipart/form-data; boundary=x", 6<<20); got != http.StatusNoContent {
		t.Errorf("6 MiB upload = %d, want 204", got)
	}
	if got := post("multipart/form-data; boundary=x", 8<<20+1); got != http.StatusRequestEntityTooLarge {
		t.Errorf("over 8 MiB upload = %d, want 413", got)
	}
}
