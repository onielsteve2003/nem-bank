// Package httpserver builds the Gin engine and owns the HTTP server lifecycle.
package httpserver

import (
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
)

const healthPath = "/v1/health"

// Options are the router's dependencies.
type Options struct {
	Version     string
	Logger      *slog.Logger
	CORSOrigins []string
	// Now is the clock; nil means time.Now.
	Now func() time.Time
}

// NewRouter returns the Gin engine with the middleware chain and every contract operation
// mounted through the generated strict server.
func NewRouter(opts Options) (*gin.Engine, error) {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	spec, err := api.GetSpec()
	if err != nil {
		return nil, fmt.Errorf("load embedded openapi spec: %w", err)
	}
	validate, err := RequestValidator(spec)
	if err != nil {
		return nil, err
	}

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	// Request ID first so every later log line and problem carries it; recovery next so a
	// panic anywhere below is still logged by AccessLog with a 500. CORS answers preflights
	// before validation, which would reject an OPTIONS the contract does not declare.
	r.Use(RequestID(), AccessLog(opts.Logger), Recovery(opts.Logger), CORS(opts.CORSOrigins))

	r.NoRoute(func(c *gin.Context) {
		writeProblem(c, http.StatusNotFound, "not_found", "No such endpoint.")
	})

	// Validation is attached to the contract's routes only, so unknown paths still 404.
	contract := r.Group("", validate)
	h := &handlers{version: opts.Version, now: opts.Now}
	api.RegisterHandlersWithOptions(contract,
		api.NewStrictHandlerWithOptions(h, nil, strictOptions(opts.Logger)),
		api.GinServerOptions{ErrorHandler: paramErrorHandler},
	)
	return r, nil
}
