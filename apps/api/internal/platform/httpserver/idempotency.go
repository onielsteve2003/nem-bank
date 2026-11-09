package httpserver

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/admin"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/idempotency"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// IdempotencyStore keeps Idempotency-Key claims and responses (*idempotency.Store).
type IdempotencyStore interface {
	Begin(ctx context.Context, scope string, key uuid.UUID, hash []byte) (*idempotency.Claim, *idempotency.Response, error)
	Complete(ctx context.Context, c *idempotency.Claim, r idempotency.Response) (bool, error)
	Release(ctx context.Context, c *idempotency.Claim) error
}

// ReplayedHeader marks a response served from the store rather than by running the
// request again.
const ReplayedHeader = "Idempotent-Replayed"

// errNoIdempotencyStore refuses keyed requests when the router was built without a
// store: running a money request without deduplication is never the safe default.
var errNoIdempotencyStore = errors.New("httpserver: no idempotency store configured")

// keyedOperation reports whether the contract requires an Idempotency-Key: the
// operation lists the header (every money-moving POST).
func keyedOperation(op *openapi3.Operation) bool {
	for _, p := range op.Parameters {
		if p.Value != nil && p.Value.In == openapi3.ParameterInHeader && strings.EqualFold(p.Value.Name, "Idempotency-Key") {
			return true
		}
	}
	return false
}

// idempotencyScope keeps each caller's keys apart, so one customer can never be handed
// another's stored response.
func idempotencyScope(ctx context.Context) string {
	if p, ok := identity.PrincipalFrom(ctx); ok {
		return "user:" + p.UserID.String()
	}
	if p, ok := admin.PrincipalFrom(ctx); ok {
		return "staff:" + p.StaffID.String()
	}
	return "public"
}

// runIdempotent runs the rest of the chain at most once per key. It sits after
// authentication, validation and the signature check, so a rejected request never
// claims a key. body is the request as the client sent it.
func runIdempotent(c *gin.Context, store IdempotencyStore, body []byte, log *slog.Logger) {
	if store == nil {
		problem.Write(c, log, errNoIdempotencyStore)
		return
	}
	// The contract has validated the header as a UUID.
	key, err := uuid.Parse(c.GetHeader("Idempotency-Key"))
	if err != nil {
		problem.Render(c, problem.Validation(problem.Field("/headers/Idempotency-Key", "format", "Must be a UUID.")))
		return
	}
	ctx := c.Request.Context()
	scope := idempotencyScope(ctx)
	claim, stored, err := store.Begin(ctx, scope, key, idempotency.Hash(c.Request.Method, c.Request.URL.RequestURI(), body))
	if errors.Is(err, idempotency.ErrInProgress) {
		c.Header("Retry-After", "1")
	}
	if err != nil {
		problem.Write(c, log, err)
		return
	}
	if stored != nil {
		c.Header(ReplayedHeader, "true")
		c.Data(stored.Status, stored.ContentType, stored.Body)
		c.Abort()
		return
	}

	w := &capturingWriter{ResponseWriter: c.Writer}
	c.Writer = w
	c.Next()
	c.Writer = w.ResponseWriter

	// The client may have gone; the key still has to be settled.
	ctx = context.WithoutCancel(ctx)
	status := w.Status()
	// A server failure or a rate limit is worth retrying, so it is not remembered. Any
	// other answer (success or a domain refusal like insufficient_funds) is final.
	if status >= http.StatusInternalServerError || status == http.StatusTooManyRequests {
		if err := store.Release(ctx, claim); err != nil {
			log.ErrorContext(ctx, "release idempotency key", "error", err)
		}
		return
	}
	saved, err := store.Complete(ctx, claim, idempotency.Response{
		Status: status, ContentType: w.Header().Get("Content-Type"), Body: w.body.Bytes(),
	})
	if err != nil {
		// Not fatal: the claim's lease runs out and a retry takes over; the ledger's own
		// entry key stops a second posting.
		log.ErrorContext(ctx, "store idempotent response", "error", err)
	} else if !saved {
		log.WarnContext(ctx, "idempotency claim lost before the response was stored")
	}
}

// capturingWriter copies the response body as it is written.
type capturingWriter struct {
	gin.ResponseWriter
	body bytes.Buffer
}

func (w *capturingWriter) Write(b []byte) (int, error) {
	w.body.Write(b)
	return w.ResponseWriter.Write(b)
}

func (w *capturingWriter) WriteString(s string) (int, error) {
	w.body.WriteString(s)
	return w.ResponseWriter.WriteString(s)
}
