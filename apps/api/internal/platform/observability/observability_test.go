package observability

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

func TestMetricsCountRequestsByRouteTemplate(t *testing.T) {
	t.Parallel()

	m := NewMetrics()
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(m.Middleware())
	r.GET("/v1/accounts/:id", func(c *gin.Context) { c.Status(http.StatusOK) })
	r.GET("/metrics", m.Handler(""))

	for _, id := range []string{"0123456789", "9876543210"} {
		r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/v1/accounts/"+id, nil))
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/metrics", nil))
	body := rec.Body.String()

	if !strings.Contains(body, `http_requests_total{method="GET",route="/v1/accounts/:id",status="200"} 2`) {
		t.Fatalf("request counter missing or wrong:\n%s", grep(body, "http_requests_total"))
	}
	if strings.Contains(body, "0123456789") {
		t.Fatal("raw path value leaked into a label")
	}
	for _, want := range []string{"http_request_duration_seconds_bucket", "go_goroutines", "http_requests_in_flight"} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing %s", want)
		}
	}
}

func TestMetricsHandlerRequiresTheTokenWhenSet(t *testing.T) {
	t.Parallel()

	h := NewMetrics().Handler("s3cret")
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.GET("/metrics", h)

	tests := []struct {
		name, auth string
		want       int
	}{
		{"no header", "", http.StatusUnauthorized},
		{"wrong token", "Bearer nope", http.StatusUnauthorized},
		{"right token", "Bearer s3cret", http.StatusOK},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/metrics", nil)
			if tt.auth != "" {
				req.Header.Set("Authorization", tt.auth)
			}
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)
			if rec.Code != tt.want {
				t.Fatalf("status = %d, want %d", rec.Code, tt.want)
			}
		})
	}
}

// recordingTransport keeps events in memory instead of sending them to Sentry.
type recordingTransport struct {
	mu     sync.Mutex
	events []*sentry.Event
}

func (t *recordingTransport) Configure(sentry.ClientOptions) {}
func (t *recordingTransport) SendEvent(e *sentry.Event) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.events = append(t.events, e)
}
func (t *recordingTransport) Flush(time.Duration) bool              { return true }
func (t *recordingTransport) FlushWithContext(context.Context) bool { return true }
func (t *recordingTransport) Close()                                {}

func newRecordingHub(t *testing.T) (*sentry.Hub, *recordingTransport) {
	t.Helper()
	tr := &recordingTransport{}
	client, err := sentry.NewClient(sentry.ClientOptions{Dsn: "https://key@o1.ingest.sentry.io/1", Transport: tr})
	if err != nil {
		t.Fatalf("sentry client: %v", err)
	}
	return sentry.NewHub(client, sentry.NewScope()), tr
}

func TestSentryHandlerSendsErrorsWithTagsAndTraceAndPassesEverythingOn(t *testing.T) {
	t.Parallel()

	hub, tr := newRecordingHub(t)
	var out bytes.Buffer
	log := slog.New(NewSentryHandler(slog.NewJSONHandler(&out, nil), hub)).With("service", ServiceName)

	tp := sdktrace.NewTracerProvider()
	ctx, span := tp.Tracer("test").Start(t.Context(), "op")
	defer span.End()

	log.InfoContext(ctx, "fine")
	log.ErrorContext(ctx, "request failed", "request_id", "req-1", "route", "/v1/x", "error", errors.New("boom"))

	if len(tr.events) != 1 {
		t.Fatalf("sent %d events, want 1 (info must not be sent)", len(tr.events))
	}
	ev := tr.events[0]
	if ev.Message != "request failed" || ev.Tags["request_id"] != "req-1" || ev.Tags["route"] != "/v1/x" {
		t.Fatalf("unexpected event: %+v", ev)
	}
	if len(ev.Exception) == 0 || ev.Exception[len(ev.Exception)-1].Value != "boom" {
		t.Fatalf("error not attached as exception: %+v", ev.Exception)
	}
	if ev.Contexts["log"]["service"] != ServiceName {
		t.Fatalf("logger attrs not carried: %+v", ev.Contexts["log"])
	}
	if got := fmt.Sprint(ev.Contexts["trace"]["trace_id"]); got != span.SpanContext().TraceID().String() {
		t.Fatalf("trace_id = %v, want the active span's", got)
	}
	if !strings.Contains(out.String(), `"msg":"fine"`) || !strings.Contains(out.String(), `"msg":"request failed"`) {
		t.Fatalf("records not passed on: %s", out.String())
	}
}

func TestSentryHandlerIsInertWithoutAClient(t *testing.T) {
	t.Parallel()

	var out bytes.Buffer
	log := slog.New(NewSentryHandler(slog.NewJSONHandler(&out, nil), sentry.NewHub(nil, sentry.NewScope())))
	log.Error("still logged")
	if !strings.Contains(out.String(), "still logged") {
		t.Fatalf("record lost: %s", out.String())
	}
}

func TestSetupTracingWithoutAnEndpointStillCreatesSpans(t *testing.T) {
	// Not parallel: SetupTracing sets the global tracer provider.
	shutdown, err := SetupTracing(t.Context(), TracingConfig{SampleRatio: 1, Version: "t", Environment: "test"})
	if err != nil {
		t.Fatalf("SetupTracing: %v", err)
	}
	defer func() { _ = shutdown(context.Background()) }()

	_, span := otel.Tracer("test").Start(t.Context(), "op")
	defer span.End()
	if !span.SpanContext().IsValid() || !span.SpanContext().IsSampled() {
		t.Fatal("want a valid, sampled span for log correlation")
	}
}

func grep(s, substr string) string {
	var lines []string
	for _, l := range strings.Split(s, "\n") {
		if strings.Contains(l, substr) {
			lines = append(lines, l)
		}
	}
	return strings.Join(lines, "\n")
}
