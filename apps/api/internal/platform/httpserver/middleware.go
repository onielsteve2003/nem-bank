package httpserver

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/logging"
)

// HeaderRequestID is echoed on every response and repeated in problem bodies.
const HeaderRequestID = "X-Request-Id"

// validRequestID limits caller-supplied IDs to a safe, log-friendly shape.
var validRequestID = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

// RequestID keeps the caller's X-Request-Id when it is well formed (so the app and the API
// share one ID per request) and otherwise generates a UUIDv7.
func RequestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.GetHeader(HeaderRequestID)
		if !validRequestID.MatchString(id) {
			id = uuid.Must(uuid.NewV7()).String()
		}
		c.Request = c.Request.WithContext(logging.WithRequestID(c.Request.Context(), id))
		c.Header(HeaderRequestID, id)
		c.Next()
	}
}

// AccessLog writes one record per request. It logs the route template, never the raw path
// or query string, because those can carry account numbers or emails.
func AccessLog(log *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()

		route := c.FullPath()
		if route == "" {
			route = "unmatched"
		}
		status := c.Writer.Status()
		level := slog.LevelInfo
		switch {
		case status >= 500:
			level = slog.LevelError
		case status >= 400:
			level = slog.LevelWarn
		case route == healthPath:
			// The uptime monitor pings this every few minutes; keep it out of normal logs.
			level = slog.LevelDebug
		}
		log.LogAttrs(c.Request.Context(), level, "http request",
			slog.String("method", c.Request.Method),
			slog.String("route", route),
			slog.Int("status", status),
			slog.Int("bytes", c.Writer.Size()),
			slog.Float64("duration_ms", float64(time.Since(start).Microseconds())/1000),
		)
	}
}

// Recovery turns a panic into a logged error and a 500 problem, so one bad handler
// never takes the process down.
func Recovery(log *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			rec := recover()
			if rec == nil {
				return
			}
			// net/http uses this panic to abort a response on purpose; let it through.
			if err, ok := rec.(error); ok && errors.Is(err, http.ErrAbortHandler) {
				panic(rec)
			}
			log.ErrorContext(c.Request.Context(), "panic in handler",
				slog.String("panic", fmt.Sprint(rec)),
				slog.String("route", c.FullPath()),
				slog.String("stack", string(debug.Stack())),
			)
			if !c.Writer.Written() {
				writeProblem(c, http.StatusInternalServerError, "internal_error", "Something went wrong on our side.")
			}
			c.Abort()
		}()
		c.Next()
	}
}

// corsAllowHeaders are the request headers the app and console send (see the contract).
var corsAllowHeaders = strings.Join([]string{
	"Authorization", "Content-Type", "Idempotency-Key", HeaderRequestID,
	"X-Device-Id", "X-Device-Signature", "X-Signature-Timestamp", "X-Nonce", "X-Step-Up-Token",
}, ", ")

// CORS allows browser calls from an exact list of origins. Credentials are not allowed:
// the API uses bearer tokens, never cookies.
func CORS(origins []string) gin.HandlerFunc {
	allowed := make(map[string]bool, len(origins))
	for _, o := range origins {
		allowed[o] = true
	}
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin == "" {
			c.Next()
			return
		}
		c.Writer.Header().Add("Vary", "Origin")
		preflight := c.Request.Method == http.MethodOptions && c.GetHeader("Access-Control-Request-Method") != ""

		if !allowed[origin] {
			if preflight {
				c.AbortWithStatus(http.StatusForbidden)
				return
			}
			// No CORS headers: the browser blocks the response. Non-browser clients are unaffected.
			c.Next()
			return
		}

		c.Header("Access-Control-Allow-Origin", origin)
		c.Header("Access-Control-Expose-Headers", HeaderRequestID)
		if preflight {
			c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE")
			c.Header("Access-Control-Allow-Headers", corsAllowHeaders)
			c.Header("Access-Control-Max-Age", strconv.Itoa(int((10 * time.Minute).Seconds())))
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

// newProblem builds an RFC 9457 body in the contract's shape; T22.5 adds the full error model.
func newProblem(c *gin.Context, status int, code, title string) api.Problem {
	p := api.Problem{Type: "about:blank", Title: title, Status: status, Code: code}
	if id := logging.RequestID(c.Request.Context()); id != "" {
		p.RequestId = &id
	}
	return p
}

func sendProblem(c *gin.Context, p api.Problem) {
	c.Header("Content-Type", "application/problem+json")
	c.JSON(p.Status, p)
}

func writeProblem(c *gin.Context, status int, code, title string) {
	sendProblem(c, newProblem(c, status, code, title))
}
