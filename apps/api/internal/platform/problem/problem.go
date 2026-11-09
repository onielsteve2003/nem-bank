// Package problem is the API's error model: RFC 9457 problem details with a stable
// machine-readable code, in the contract's Problem shape.
//
// Domains return *Error values (often package-level sentinels such as
// ErrInsufficientFunds = problem.New(422, "insufficient_funds", "...")), wrapped with
// fmt.Errorf("...: %w", err) as they travel up. Write finds the *Error anywhere in the
// chain and renders it; any other error becomes a logged, opaque 500.
package problem

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/logging"
)

// ContentType is the media type of every error response.
const ContentType = "application/problem+json"

// TypeBase prefixes the code to form `type`. It is the same identifier the app's mock bank
// uses, so a problem reads the same from either source. RFC 9457 type URIs identify the
// problem; they need not resolve.
const TypeBase = "https://nem.bank/problems/"

// Platform-wide codes. Domain codes (insufficient_funds, pin_locked, ...) live with their
// domain, next to the sentinel that uses them.
const (
	CodeValidationFailed    = "validation_failed"
	CodeUnauthorized        = "unauthorized"
	CodeForbidden           = "forbidden"
	CodeNotFound            = "not_found"
	CodeMethodNotAllowed    = "method_not_allowed"
	CodeConflict            = "conflict"
	CodeIdempotencyConflict = "idempotency_conflict"
	CodePaidFeatureRequired = "paid_feature_required"
	CodeRateLimited         = "rate_limited"
	CodeInternal            = "internal_error"
	CodeNotImplemented      = "not_implemented"
	CodeTimeout             = "timeout"
)

// Error is a problem a handler or domain can return. Treat values as immutable: the With
// methods return a modified copy, so package-level sentinels are safe to share.
type Error struct {
	Status  int
	Code    string
	Title   string
	Detail  string
	Fields  []api.FieldError
	Feature string
	RetryAt time.Time
	cause   error
}

// New returns a problem. Title is short and user-facing; put specifics in Detail.
func New(status int, code, title string) *Error {
	return &Error{Status: status, Code: code, Title: title}
}

func (e *Error) Error() string {
	msg := e.Code + ": " + e.Title
	if e.Detail != "" {
		msg += " (" + e.Detail + ")"
	}
	if e.cause != nil {
		msg += ": " + e.cause.Error()
	}
	return msg
}

// Unwrap exposes the cause for errors.Is/As and for logs; it is never sent to the client.
func (e *Error) Unwrap() error { return e.cause }

// Is matches on status and code, so errors.Is(err, ErrSentinel) still holds after
// WithDetail or WithCause made a copy.
func (e *Error) Is(target error) bool {
	var t *Error
	if !errors.As(target, &t) {
		return false
	}
	return t.Code == e.Code && t.Status == e.Status
}

func (e *Error) clone() *Error {
	c := *e
	c.Fields = append([]api.FieldError(nil), e.Fields...)
	return &c
}

// WithDetail returns a copy with a human-readable explanation of this occurrence.
func (e *Error) WithDetail(detail string) *Error {
	c := e.clone()
	c.Detail = detail
	return c
}

// WithDetailf is WithDetail with formatting.
func (e *Error) WithDetailf(format string, args ...any) *Error {
	return e.WithDetail(fmt.Sprintf(format, args...))
}

// WithCause returns a copy that records the underlying error for logs only.
func (e *Error) WithCause(err error) *Error {
	c := e.clone()
	c.cause = err
	return c
}

// WithFields returns a copy with field-level errors appended.
func (e *Error) WithFields(fields ...api.FieldError) *Error {
	c := e.clone()
	c.Fields = append(c.Fields, fields...)
	return c
}

// WithRetryAt returns a copy that tells the client when to try again (sets Retry-After).
func (e *Error) WithRetryAt(t time.Time) *Error {
	c := e.clone()
	c.RetryAt = t
	return c
}

// Validation is a 400 with one entry per invalid field.
func Validation(fields ...api.FieldError) *Error {
	return New(http.StatusBadRequest, CodeValidationFailed, "The request is not valid.").WithFields(fields...)
}

// Field is a FieldError; field is a JSON Pointer for body fields ("/amount") or
// "<in>.<name>" for parameters ("query.cursor").
func Field(field, code, message string) api.FieldError {
	return api.FieldError{Field: field, Code: code, Message: message}
}

// Unauthorized is a 401: no valid credentials.
func Unauthorized() *Error {
	return New(http.StatusUnauthorized, CodeUnauthorized, "Sign in to continue.")
}

// Forbidden is a 403: authenticated, but not allowed.
func Forbidden() *Error {
	return New(http.StatusForbidden, CodeForbidden, "You are not allowed to do this.")
}

// NotFound is a 404 for a resource; what is a plain noun like "Beneficiary".
func NotFound(what string) *Error {
	return New(http.StatusNotFound, CodeNotFound, what+" not found.")
}

// Conflict is a 409 for a request that clashes with the current state.
func Conflict(detail string) *Error {
	return New(http.StatusConflict, CodeConflict, "This conflicts with the current state.").WithDetail(detail)
}

// IdempotencyConflict is a 422: the Idempotency-Key was used before with a different body.
func IdempotencyConflict() *Error {
	return New(http.StatusUnprocessableEntity, CodeIdempotencyConflict,
		"This Idempotency-Key was already used for a different request.")
}

// PaidFeatureRequired is a 403 for a feature that needs a paid partner (PRD §11).
func PaidFeatureRequired(feature string) *Error {
	e := New(http.StatusForbidden, CodePaidFeatureRequired, "This feature needs a paid partner and is switched off.")
	e.Feature = feature
	return e
}

// RateLimited is a 429 that says when the client may retry.
func RateLimited(retryAt time.Time) *Error {
	return New(http.StatusTooManyRequests, CodeRateLimited, "Too many requests. Try again shortly.").WithRetryAt(retryAt)
}

// NotImplemented is a 501 for a contract operation whose domain is not built yet.
func NotImplemented() *Error {
	return New(http.StatusNotImplemented, CodeNotImplemented, "This endpoint is not available yet.")
}

// Internal is the opaque 500 the client sees for anything unexpected.
func Internal() *Error {
	return New(http.StatusInternalServerError, CodeInternal, "Something went wrong on our side.")
}

// Write renders err as a problem response. A *Error anywhere in the chain is sent as is;
// anything else is logged with its cause and sent as an opaque 500, so internals never
// reach the client. Server-side problems (5xx) are always logged.
func Write(c *gin.Context, log *slog.Logger, err error) {
	ctx := c.Request.Context()
	var p *Error
	switch {
	case errors.As(err, &p):
	case errors.Is(err, context.Canceled) && ctx.Err() != nil:
		// The client went away; nobody is left to read a body.
		log.DebugContext(ctx, "request canceled", slog.String("route", c.FullPath()))
		c.Abort()
		return
	case errors.Is(err, context.DeadlineExceeded):
		p = New(http.StatusGatewayTimeout, CodeTimeout, "This took too long. Try again.").WithCause(err)
	default:
		p = Internal().WithCause(err)
	}
	if p.Status >= http.StatusInternalServerError {
		log.ErrorContext(ctx, "request failed",
			slog.String("route", c.FullPath()), slog.String("code", p.Code), slog.Any("error", err))
	}
	Render(c, p)
}

// Render sends p without logging, for callers that already logged (panic recovery) or
// whose problems are the client's (validation, unknown routes). It aborts the chain.
func Render(c *gin.Context, p *Error) {
	if c.Writer.Written() {
		c.Abort()
		return
	}
	if !p.RetryAt.IsZero() {
		secs := math.Ceil(time.Until(p.RetryAt).Seconds())
		c.Header("Retry-After", strconv.Itoa(int(max(secs, 1))))
	}
	c.Header("Content-Type", ContentType)
	c.AbortWithStatusJSON(p.Status, body(c, p))
}

func body(c *gin.Context, p *Error) api.Problem {
	out := api.Problem{Type: TypeBase + p.Code, Title: p.Title, Status: p.Status, Code: p.Code}
	if p.Detail != "" {
		out.Detail = &p.Detail
	}
	if len(p.Fields) > 0 {
		out.Errors = &p.Fields
	}
	if p.Feature != "" {
		out.Feature = &p.Feature
	}
	if !p.RetryAt.IsZero() {
		t := p.RetryAt.UTC()
		out.RetryAt = &t
	}
	if id := logging.RequestID(c.Request.Context()); id != "" {
		out.RequestId = &id
	}
	return out
}
