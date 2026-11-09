package httpserver

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// handlers implements the contract's strict server. Operations not overridden here fall
// through to api.Unimplemented and answer 501 until their domain is built.
type handlers struct {
	api.Unimplemented
	version string
	now     func() time.Time
}

var _ api.StrictServerInterface = (*handlers)(nil)

func (h *handlers) GetHealth(context.Context, api.GetHealthRequestObject) (api.GetHealthResponseObject, error) {
	return api.GetHealth200JSONResponse{Status: api.HealthStatusOk, Version: h.version, Time: h.now().UTC()}, nil
}

// strictOptions sends every failure path of the generated handlers through problem+json.
func strictOptions(log *slog.Logger) api.StrictGinServerOptions {
	return api.StrictGinServerOptions{
		RequestErrorHandlerFunc: func(c *gin.Context, _ error) {
			// Reached only when the body passed validation but failed to bind, e.g. a JSON
			// number too large for its Go type.
			problem.Render(c, problem.Validation(problem.Field("/", "malformed", "The request body could not be read.")))
		},
		HandlerErrorFunc: func(c *gin.Context, err error) {
			if errors.Is(err, api.ErrNotImplemented) {
				problem.Render(c, problem.NotImplemented())
				return
			}
			problem.Write(c, log, err)
		},
		ResponseErrorHandlerFunc: func(c *gin.Context, err error) {
			problem.Write(c, log, fmt.Errorf("write response: %w", err))
		},
	}
}

// paramErrorHandler covers parameters the generated wrapper cannot bind. The validator
// runs first and catches these, so this is a backstop that keeps the problem shape.
func paramErrorHandler(c *gin.Context, _ error, status int) {
	if status == http.StatusBadRequest {
		problem.Render(c, problem.Validation(problem.Field("/", "malformed", "A parameter could not be read.")))
		return
	}
	problem.Render(c, problem.New(status, "invalid_request", http.StatusText(status)))
}
