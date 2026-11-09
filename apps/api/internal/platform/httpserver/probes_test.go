package httpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

type pingFunc func(ctx context.Context) error

func (f pingFunc) Ping(ctx context.Context) error { return f(ctx) }

func newProbeRouter(t *testing.T, logs *bytes.Buffer, checks ...ReadinessCheck) http.Handler {
	t.Helper()
	r, err := NewRouter(Options{
		Version:   "test-1",
		Logger:    slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelInfo})),
		Readiness: checks,
	})
	if err != nil {
		t.Fatalf("new router: %v", err)
	}
	return r
}

func decodeProbe(t *testing.T, body []byte) probeResponse {
	t.Helper()
	var p probeResponse
	if err := json.Unmarshal(body, &p); err != nil {
		t.Fatalf("decode probe body %q: %v", body, err)
	}
	return p
}

func TestLivenessIgnoresDependencies(t *testing.T) {
	t.Parallel()

	down := ReadinessCheck{Name: "database", Pinger: pingFunc(func(context.Context) error { return errors.New("down") })}
	rec := do(t, newProbeRouter(t, &bytes.Buffer{}, down), http.MethodGet, LivenessPath, nil)
	if rec.Code != http.StatusOK || decodeProbe(t, rec.Body.Bytes()).Status != "ok" {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
}

func TestReadinessIsOKWhenEveryCheckPasses(t *testing.T) {
	t.Parallel()

	up := ReadinessCheck{Name: "database", Pinger: pingFunc(func(context.Context) error { return nil })}
	rec := do(t, newProbeRouter(t, &bytes.Buffer{}, up), http.MethodGet, ReadinessPath, nil)
	got := decodeProbe(t, rec.Body.Bytes())
	if rec.Code != http.StatusOK || got.Status != "ok" || got.Checks["database"] != "ok" {
		t.Fatalf("got %d %+v", rec.Code, got)
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("readiness must not be cached")
	}
}

func TestReadinessIs503AndHidesTheErrorWhenADependencyFails(t *testing.T) {
	t.Parallel()

	var logs bytes.Buffer
	secret := "dial tcp 10.0.0.5:5432: password authentication failed"
	checks := []ReadinessCheck{
		{Name: "database", Pinger: pingFunc(func(context.Context) error { return errors.New(secret) })},
		{Name: "cache", Pinger: pingFunc(func(context.Context) error { return nil })},
	}
	rec := do(t, newProbeRouter(t, &logs, checks...), http.MethodGet, ReadinessPath, nil)
	got := decodeProbe(t, rec.Body.Bytes())
	if rec.Code != http.StatusServiceUnavailable || got.Status != "unavailable" ||
		got.Checks["database"] != "fail" || got.Checks["cache"] != "ok" {
		t.Fatalf("got %d %+v", rec.Code, got)
	}
	if bytes.Contains(rec.Body.Bytes(), []byte("password")) {
		t.Fatalf("error detail leaked into the public body: %s", rec.Body)
	}
	if !bytes.Contains(logs.Bytes(), []byte("readiness check failed")) {
		t.Fatalf("failure was not logged: %s", logs.String())
	}
}

func TestReadinessBoundsAHungDependency(t *testing.T) {
	t.Parallel()

	hung := ReadinessCheck{Name: "database", Pinger: pingFunc(func(ctx context.Context) error {
		if _, ok := ctx.Deadline(); !ok {
			return errors.New("no deadline on the probe context")
		}
		<-ctx.Done()
		return ctx.Err()
	})}
	// The request context is cancelled up front, so this proves the check honours ctx
	// without waiting out the real timeout.
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	req := httptest.NewRequestWithContext(ctx, http.MethodGet, ReadinessPath, nil)
	rec := httptest.NewRecorder()
	newProbeRouter(t, &bytes.Buffer{}, hung).ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d, want 503", rec.Code)
	}
}

func TestProbesStayOutOfInfoLogs(t *testing.T) {
	t.Parallel()

	var logs bytes.Buffer
	h := newProbeRouter(t, &logs)
	do(t, h, http.MethodGet, LivenessPath, nil)
	do(t, h, http.MethodGet, ReadinessPath, nil)
	if bytes.Contains(logs.Bytes(), []byte("http request")) {
		t.Fatalf("probe requests logged at info: %s", logs.String())
	}
}
