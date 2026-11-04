// Package httpserver builds the Gin engine and owns the HTTP server lifecycle.
package httpserver

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

const healthPath = "/v1/health"

// Health is the body of GET /v1/health (components.schemas.Health in the contract).
type Health struct {
	Status  string    `json:"status"`
	Version string    `json:"version"`
	Time    time.Time `json:"time"`
}

// Options are the router's dependencies.
type Options struct {
	Version     string
	Logger      *slog.Logger
	CORSOrigins []string
}

// NewRouter returns the Gin engine with the middleware chain and every route mounted.
func NewRouter(opts Options) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	// Request ID first so every later log line and problem carries it; recovery next so a
	// panic anywhere below is still logged by AccessLog with a 500.
	r.Use(RequestID(), AccessLog(opts.Logger), Recovery(opts.Logger), CORS(opts.CORSOrigins))

	r.NoRoute(func(c *gin.Context) {
		writeProblem(c, http.StatusNotFound, "not_found", "No such endpoint.")
	})

	r.GET(healthPath, func(c *gin.Context) {
		c.JSON(http.StatusOK, Health{Status: "ok", Version: opts.Version, Time: time.Now().UTC()})
	})

	return r
}
