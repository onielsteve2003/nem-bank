// Package logging builds the JSON slog logger and carries request-scoped attributes.
//
// Never log PII (names, BVN, PAN, phone, email): log IDs instead.
package logging

import (
	"context"
	"io"
	"log/slog"

	"go.opentelemetry.io/otel/trace"
)

// New returns a JSON logger that writes to w at the given level. Every record carries the
// service name and version, and the request and trace IDs when the context has them.
// wrap, when given, sits between the context handler and the JSON output (the Sentry
// forwarder), so it sees records with those IDs already attached.
func New(w io.Writer, level slog.Level, version string, wrap ...func(slog.Handler) slog.Handler) *slog.Logger {
	var h slog.Handler = slog.NewJSONHandler(w, &slog.HandlerOptions{Level: level})
	for _, fn := range wrap {
		h = fn(h)
	}
	return slog.New(contextHandler{h}).With("service", "nem-api", "version", version)
}

type requestIDKey struct{}

// WithRequestID returns a context that carries the request ID.
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDKey{}, id)
}

// RequestID returns the request ID in ctx, or "" when there is none.
func RequestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

// contextHandler adds the request ID and OpenTelemetry trace and span IDs to every record
// logged with a request context, so domain code only needs slog.InfoContext(ctx, ...) to
// be traceable, and a log line in Grafana jumps straight to its trace.
type contextHandler struct{ slog.Handler }

func (h contextHandler) Handle(ctx context.Context, r slog.Record) error {
	if id := RequestID(ctx); id != "" {
		r.AddAttrs(slog.String("request_id", id))
	}
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		r.AddAttrs(slog.String("trace_id", sc.TraceID().String()), slog.String("span_id", sc.SpanID().String()))
	}
	return h.Handler.Handle(ctx, r)
}

func (h contextHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return contextHandler{h.Handler.WithAttrs(attrs)}
}

func (h contextHandler) WithGroup(name string) slog.Handler {
	return contextHandler{h.Handler.WithGroup(name)}
}
