package observability

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/getsentry/sentry-go"
	"go.opentelemetry.io/otel/trace"
)

// SentryConfig enables error tracking. An empty DSN turns it off.
type SentryConfig struct {
	DSN         string
	Version     string
	Environment string
}

// SetupSentry starts the Sentry client. The returned function flushes queued events.
//
// Errors reach Sentry through the logger (see SentryHandler), not through a separate call
// at every site: anything logged at error level, from a failed request to a recovered
// panic, becomes one event with the request and trace IDs attached.
func SetupSentry(cfg SentryConfig) (func(), error) {
	if cfg.DSN == "" {
		return func() {}, nil
	}
	err := sentry.Init(sentry.ClientOptions{
		Dsn:         cfg.DSN,
		Release:     cfg.Version,
		Environment: cfg.Environment,
		// Events are built only from our PII-free log records; no request or user is ever
		// attached, and the SDK's own default-PII collection stays off (its default).
	})
	if err != nil {
		return nil, fmt.Errorf("sentry init: %w", err)
	}
	return func() { sentry.Flush(2 * time.Second) }, nil
}

// SentryHandler forwards error-level records to Sentry and passes every record on to next.
// It sits under logging's context handler, so request_id is already on the record.
type SentryHandler struct {
	next  slog.Handler
	hub   *sentry.Hub
	attrs []slog.Attr
}

// NewSentryHandler wraps next. A nil hub means the current global hub.
func NewSentryHandler(next slog.Handler, hub *sentry.Hub) *SentryHandler {
	if hub == nil {
		hub = sentry.CurrentHub()
	}
	return &SentryHandler{next: next, hub: hub}
}

// Enabled implements slog.Handler.
func (h *SentryHandler) Enabled(ctx context.Context, l slog.Level) bool {
	return l >= slog.LevelError || h.next.Enabled(ctx, l)
}

// Handle implements slog.Handler.
func (h *SentryHandler) Handle(ctx context.Context, r slog.Record) error {
	if r.Level >= slog.LevelError && h.hub.Client() != nil {
		hub := h.hub
		// Link the event to its OTel trace, so Sentry's issue page shows the request's trace
		// ID. Sentry takes the trace from the scope, so set it on a per-event clone (errors
		// are rare; the shared hub's scope stays untouched by concurrent requests).
		if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
			hub = h.hub.Clone()
			hub.Scope().SetPropagationContext(sentry.PropagationContext{
				TraceID: sentry.TraceID(sc.TraceID()), SpanID: sentry.SpanID(sc.SpanID()),
			})
		}
		hub.CaptureEvent(h.event(r))
	}
	if h.next.Enabled(ctx, r.Level) {
		return h.next.Handle(ctx, r)
	}
	return nil
}

// WithAttrs implements slog.Handler.
func (h *SentryHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &SentryHandler{next: h.next.WithAttrs(attrs), hub: h.hub, attrs: append(append([]slog.Attr{}, h.attrs...), attrs...)}
}

// WithGroup implements slog.Handler. Groups are flattened for Sentry; none are used today.
func (h *SentryHandler) WithGroup(name string) slog.Handler {
	return &SentryHandler{next: h.next.WithGroup(name), hub: h.hub, attrs: h.attrs}
}

func (h *SentryHandler) event(r slog.Record) *sentry.Event {
	ev := sentry.NewEvent()
	ev.Level = sentry.LevelError
	ev.Message = r.Message
	ev.Timestamp = r.Time
	ev.Logger = ServiceName
	// Other attributes go in a "log" context: Sentry shows it on the event without indexing it.
	extra := sentry.Context{}

	add := func(a slog.Attr) {
		v := a.Value.Resolve()
		switch a.Key {
		case "error":
			if err, ok := v.Any().(error); ok {
				ev.SetException(err, 5)
				return
			}
		case "request_id", "route", "code":
			// Low-cardinality fields become tags so Sentry can group and search on them.
			ev.Tags[a.Key] = v.String()
			return
		}
		extra[a.Key] = v.String()
	}
	for _, a := range h.attrs {
		add(a)
	}
	r.Attrs(func(a slog.Attr) bool { add(a); return true })
	if len(extra) > 0 {
		ev.Contexts["log"] = extra
	}

	return ev
}
