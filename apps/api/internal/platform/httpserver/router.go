// Package httpserver builds the Gin engine and owns the HTTP server lifecycle.
package httpserver

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// Health is the body of GET /v1/health (components.schemas.Health in the contract).
type Health struct {
	Status  string    `json:"status"`
	Version string    `json:"version"`
	Time    time.Time `json:"time"`
}

// NewRouter returns the Gin engine with every route mounted. version is reported by /v1/health.
func NewRouter(version string) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()

	r.GET("/v1/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, Health{Status: "ok", Version: version, Time: time.Now().UTC()})
	})

	return r
}
