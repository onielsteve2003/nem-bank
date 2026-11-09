// Package observability wires the API's traces (OpenTelemetry), metrics (Prometheus) and
// error tracking (Sentry). Every exporter is optional and free-tier: with nothing configured
// the API still creates spans (so logs carry trace IDs) but sends them nowhere.
package observability

import (
	"context"
	"errors"
	"fmt"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.40.0"
)

// ServiceName names the API in traces, metrics and error reports.
const ServiceName = "nem-api"

// TracingConfig selects where spans go.
type TracingConfig struct {
	// Endpoint is an OTLP/HTTP base URL (Grafana Cloud's free OTLP gateway in production).
	// Empty keeps tracing local: spans exist for log correlation but are not exported.
	// Auth headers come from the standard OTEL_EXPORTER_OTLP_HEADERS variable, which the
	// exporter reads itself, so the token never passes through our config.
	Endpoint string
	// SampleRatio is the share of new traces kept (0..1). Incoming sampled parents are
	// always honoured so a trace started by a client stays whole.
	SampleRatio float64
	Version     string
	Environment string
}

// SetupTracing installs the global tracer provider and W3C propagators. The returned
// function flushes buffered spans; call it during shutdown.
func SetupTracing(ctx context.Context, cfg TracingConfig) (func(context.Context) error, error) {
	res, err := resource.Merge(resource.Default(), resource.NewWithAttributes(semconv.SchemaURL,
		semconv.ServiceName(ServiceName),
		semconv.ServiceVersion(cfg.Version),
		semconv.DeploymentEnvironmentName(cfg.Environment),
	))
	if err != nil && !errors.Is(err, resource.ErrSchemaURLConflict) {
		return nil, fmt.Errorf("tracing resource: %w", err)
	}

	opts := []sdktrace.TracerProviderOption{
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(cfg.SampleRatio))),
	}
	if cfg.Endpoint != "" {
		exp, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpointURL(cfg.Endpoint))
		if err != nil {
			return nil, fmt.Errorf("otlp exporter: %w", err)
		}
		opts = append(opts, sdktrace.WithBatcher(exp))
	}
	tp := sdktrace.NewTracerProvider(opts...)
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))
	return tp.Shutdown, nil
}
