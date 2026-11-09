package httpserver

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// Probe paths sit outside /v1 and the contract: they are for the platform (Render's health
// check, Docker HEALTHCHECK, uptime monitors), not for app clients.
const (
	LivenessPath  = "/healthz"
	ReadinessPath = "/readyz"
)

// readyTimeout keeps a hung database from hanging the probe. A cold Neon database can take a
// few seconds to wake, so this is generous; the probe reports not-ready rather than waiting.
const readyTimeout = 3 * time.Second

// Pinger is a dependency readiness checks reach, e.g. the pgx pool.
type Pinger interface {
	Ping(ctx context.Context) error
}

// ReadinessCheck is one named dependency the API needs before it should take traffic.
type ReadinessCheck struct {
	Name   string
	Pinger Pinger
}

type probeResponse struct {
	Status string            `json:"status"`
	Checks map[string]string `json:"checks,omitempty"`
}

// liveness answers 200 while the process can serve HTTP at all. It never touches
// dependencies: a database outage must not make the platform restart a healthy process.
func liveness(c *gin.Context) {
	c.JSON(http.StatusOK, probeResponse{Status: "ok"})
}

// readiness answers 200 only when every dependency responds, and 503 with the failing
// check names otherwise. Error details go to the log, never the body: the probe is public.
func readiness(checks []ReadinessCheck, log *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), readyTimeout)
		defer cancel()

		resp := probeResponse{Status: "ok", Checks: make(map[string]string, len(checks))}
		status := http.StatusOK
		for _, chk := range checks {
			if err := chk.Pinger.Ping(ctx); err != nil {
				log.WarnContext(ctx, "readiness check failed", "check", chk.Name, "error", err.Error())
				resp.Checks[chk.Name] = "fail"
				resp.Status = "unavailable"
				status = http.StatusServiceUnavailable
				continue
			}
			resp.Checks[chk.Name] = "ok"
		}
		c.Header("Cache-Control", "no-store")
		c.JSON(status, resp)
	}
}

// isProbe reports whether route is a health endpoint the access log should keep quiet.
func isProbe(route string) bool {
	return route == healthPath || route == LivenessPath || route == ReadinessPath
}
