// Package httpserver builds the Gin engine and owns the HTTP server lifecycle.
package httpserver

import (
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic/gin/otelgin"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/admin"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/bills"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/cards"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/fx"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/limits"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/observability"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/realtime"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/savings"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers"
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
	// Accounts serves accounts, balances, holds and transaction history; nil in tests
	// that do not need them.
	Accounts *accounts.API
	// Transfers sends money; nil answers 501 for its operations.
	Transfers *transfers.API
	// Limits serves the customer's own limits; nil answers 501 for its operations.
	Limits *limits.API
	// FX serves rates, quotes and conversions; nil answers 501 for its operations.
	FX *fx.API
	// Cards serves virtual cards and the merchant simulator; nil answers 501 for its operations.
	Cards *cards.API
	// Bills serves bill payments; nil answers 501 for its operations.
	Bills *bills.API
	// Savings serves goals, round-ups and locked savings; nil answers 501 for its operations.
	Savings *savings.API
	// Realtime serves tickets and the WebSocket; nil answers 501 and mounts no socket.
	Realtime *realtime.Service
	// Admin serves staff login and maker-checker; nil in tests that skip the console.
	Admin *admin.API
	// StaffAuthenticator verifies console tokens; nil makes every staff operation a 401.
	StaffAuthenticator Authenticator
	// Signatures verifies device signatures on money-moving requests; nil refuses them all.
	Signatures SignatureVerifier
	// PartnerCallbacks verifies partner webhook signatures; nil refuses every callback.
	PartnerCallbacks PartnerVerifier
	// Idempotency stores Idempotency-Key claims and responses; nil refuses every
	// operation that takes the header.
	Idempotency IdempotencyStore
	// RateLimits are the request limits; nil means DefaultRateLimits.
	RateLimits *RateLimits
	// ClientIPHeader names the header the hosting proxy puts the caller's address in (for
	// example CF-Connecting-IP). Empty means the TCP peer address. X-Forwarded-For is never
	// trusted as sent, because a caller could set it to dodge the per-address limits.
	ClientIPHeader string
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
	limits := DefaultRateLimits()
	if opts.RateLimits != nil {
		limits = *opts.RateLimits
	}
	lim := newLimiter(limits, opts.Now)
	validate, err := requestValidator(spec, opts.Authenticator, opts.StaffAuthenticator, opts.Signatures, opts.Idempotency, lim.byCustomer, opts.PartnerCallbacks, opts.Logger)
	if err != nil {
		return nil, err
	}

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	// The strict handlers receive the *gin.Context as their context.Context. Without the
	// fallback its Value, Done and Deadline ignore the request context, so handlers would
	// lose the caller, cancellation and the trace parent of their database spans.
	r.ContextWithFallback = true
	// The caller's address feeds the per-address limits, so it must not be spoofable.
	if err := r.SetTrustedProxies(nil); err != nil {
		return nil, fmt.Errorf("trusted proxies: %w", err)
	}
	r.TrustedPlatform = opts.ClientIPHeader
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
	if opts.Realtime != nil {
		// A WebSocket upgrade, not a contract operation: the one-time ticket is its credential.
		r.GET(realtime.Path, opts.Realtime.Handler)
	}

	// Validation is attached to the contract's routes only, so unknown paths still 404.
	contract := r.Group("", lim.byAddress(), validate)
	h := &handlers{API: opts.Identity, adminAPI: opts.Admin, accountsAPI: opts.Accounts, transfersAPI: opts.Transfers, limitsAPI: opts.Limits, fxAPI: opts.FX, cardsAPI: opts.Cards, billsAPI: opts.Bills, savingsAPI: opts.Savings, realtimeAPI: realtimeOps(opts.Realtime), version: opts.Version, now: opts.Now}
	api.RegisterHandlersWithOptions(contract,
		api.NewStrictHandlerWithOptions(h, nil, strictOptions(opts.Logger)),
		api.GinServerOptions{ErrorHandler: paramErrorHandler},
	)
	return r, nil
}

// realtimeOps is the ticket operation, or nil (which answers 501) without a realtime service.
func realtimeOps(s *realtime.Service) *realtime.API {
	if s == nil {
		return nil
	}
	return realtime.NewAPI(s)
}
