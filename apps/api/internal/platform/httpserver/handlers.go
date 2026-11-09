package httpserver

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
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
			writeValidationProblem(c, []api.FieldError{{Field: "/", Code: "malformed", Message: "The request body could not be read."}})
		},
		HandlerErrorFunc: func(c *gin.Context, err error) {
			if errors.Is(err, api.ErrNotImplemented) {
				writeProblem(c, http.StatusNotImplemented, "not_implemented", "This endpoint is not available yet.")
				return
			}
			log.ErrorContext(c.Request.Context(), "handler error", slog.String("route", c.FullPath()), slog.Any("error", err))
			writeProblem(c, http.StatusInternalServerError, "internal_error", "Something went wrong on our side.")
		},
		ResponseErrorHandlerFunc: func(c *gin.Context, err error) {
			log.ErrorContext(c.Request.Context(), "response error", slog.String("route", c.FullPath()), slog.Any("error", err))
			if !c.Writer.Written() {
				writeProblem(c, http.StatusInternalServerError, "internal_error", "Something went wrong on our side.")
			}
		},
	}
}

// paramErrorHandler covers parameters the generated wrapper cannot bind. The validator
// runs first and catches these, so this is a backstop that keeps the problem shape.
func paramErrorHandler(c *gin.Context, _ error, status int) {
	if status == http.StatusBadRequest {
		writeValidationProblem(c, []api.FieldError{{Field: "/", Code: "malformed", Message: "A parameter could not be read."}})
		return
	}
	writeProblem(c, status, "invalid_request", http.StatusText(status))
}
