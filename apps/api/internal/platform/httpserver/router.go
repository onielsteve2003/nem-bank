// Package httpserver builds the Gin engine and owns the HTTP server lifecycle.
package httpserver

import (
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic/gin/otelgin"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/observability"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

const (
	healthPath = "/v1/health"
	// MetricsPath serves Prometheus metrics, outside /v1 like the probes.
	MetricsPath = "/metrics"
)

// Options are the router's dependencies.
type Options struct {
	Version     string
	Logger      *slog.Logger
	CORSOrigins []string
	// Readiness lists the dependencies /readyz checks (the database in production).
	Readiness []ReadinessCheck
	// Metrics records HTTP metrics and serves /metrics; nil gets a fresh registry.
	Metrics *observability.Metrics
	// MetricsToken, when set, is the bearer token /metrics requires.
	MetricsToken string
	// Now is the clock; nil means time.Now.
	Now func() time.Time
	// Identity serves sign-up, sessions, devices and the PIN. Nil in tests that only
	// exercise the platform routes.
	Identity *identity.API
	// Authenticator verifies bearer tokens; nil makes every protected operation a 401.
	Authenticator Authenticator
}

// NewRouter returns the Gin engine with the middleware chain and every contract operation
// mounted through the generated strict server.
func NewRouter(opts Options) (*gin.Engine, error) {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Metrics == nil {
		opts.Metrics = observability.NewMetrics()
	}
	spec, err := api.GetSpec()
	if err != nil {
		return nil, fmt.Errorf("load embedded openapi spec: %w", err)
	}
	validate, err := RequestValidator(spec, opts.Authenticator, opts.Logger)
	if err != nil {
		return nil, err
	}

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	// The strict handlers receive the *gin.Context as their context.Context. Without the
	// fallback its Value, Done and Deadline ignore the request context, so handlers would
	// lose the caller, cancellation and the trace parent of their database spans.
	r.ContextWithFallback = true
	// Request ID first so every later log line and problem carries it; recovery next so a
	// panic anywhere below is still logged by AccessLog with a 500. CORS answers preflights
	// before validation, which would reject an OPTIONS the contract does not declare.
	// Tracing comes before AccessLog so its log line carries the trace ID. Probes and scrapes
	// are not traced: they would bury real requests under thousands of identical spans.
	r.Use(
		RequestID(),
		otelgin.Middleware(observability.ServiceName, otelgin.WithGinFilter(func(c *gin.Context) bool {
			return !isProbe(c.FullPath())
		})),
		opts.Metrics.Middleware(),
		AccessLog(opts.Logger), Recovery(opts.Logger), CORS(opts.CORSOrigins),
	)

	r.NoRoute(func(c *gin.Context) {
		problem.Render(c, problem.New(http.StatusNotFound, problem.CodeNotFound, "No such endpoint."))
	})
	// A known path with the wrong method is a 405 with an Allow header, not a 404.
	r.HandleMethodNotAllowed = true
	r.NoMethod(func(c *gin.Context) {
		problem.Render(c, problem.New(http.StatusMethodNotAllowed, problem.CodeMethodNotAllowed,
			"This endpoint does not support "+c.Request.Method+"."))
	})

	r.GET(LivenessPath, liveness)
	r.GET(ReadinessPath, readiness(opts.Readiness, opts.Logger))
	r.GET(MetricsPath, opts.Metrics.Handler(opts.MetricsToken))

	// Validation is attached to the contract's routes only, so unknown paths still 404.
	contract := r.Group("", validate)
	h := &handlers{API: opts.Identity, version: opts.Version, now: opts.Now}
	api.RegisterHandlersWithOptions(contract,
		api.NewStrictHandlerWithOptions(h, nil, strictOptions(opts.Logger)),
		api.GinServerOptions{ErrorHandler: paramErrorHandler},
	)
	return r, nil
}
