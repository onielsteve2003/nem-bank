package problem

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/logging"
)

var errInsufficientFunds = New(http.StatusUnprocessableEntity, "insufficient_funds", "Not enough money.")

// render runs Write for err inside a Gin request and returns the response and the logs.
func render(ctx context.Context, t *testing.T, err error) (*httptest.ResponseRecorder, string) {
	t.Helper()
	var logs bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequestWithContext(logging.WithRequestID(ctx, "req-1"), http.MethodGet, "/x", nil)
	Write(c, log, err)
	return rec, logs.String()
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) api.Problem {
	t.Helper()
	if ct := rec.Header().Get("Content-Type"); ct != ContentType {
		t.Fatalf("content type = %q", ct)
	}
	var p api.Problem
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return p
}

func TestWriteRendersAWrappedDomainProblem(t *testing.T) {
	t.Parallel()

	err := fmt.Errorf("send money: %w", errInsufficientFunds.WithDetail("Your NGN balance is too low."))
	rec, logs := render(t.Context(), t, err)

	p := decode(t, rec)
	if rec.Code != http.StatusUnprocessableEntity || p.Status != rec.Code || p.Code != "insufficient_funds" {
		t.Fatalf("got %d %+v", rec.Code, p)
	}
	if p.Type != "https://nem.bank/problems/insufficient_funds" || p.Title != "Not enough money." {
		t.Fatalf("type/title = %q / %q", p.Type, p.Title)
	}
	if p.Detail == nil || *p.Detail != "Your NGN balance is too low." || p.RequestId == nil || *p.RequestId != "req-1" {
		t.Fatalf("detail/request_id missing: %+v", p)
	}
	if logs != "" {
		t.Fatalf("a 4xx should not be logged: %s", logs)
	}
}

func TestUnknownErrorsBecomeAnOpaqueLogged500(t *testing.T) {
	t.Parallel()

	rec, logs := render(t.Context(), t, errors.New("relation users_secret does not exist"))
	p := decode(t, rec)
	if rec.Code != http.StatusInternalServerError || p.Code != CodeInternal {
		t.Fatalf("got %d %+v", rec.Code, p)
	}
	if strings.Contains(rec.Body.String(), "users_secret") {
		t.Fatalf("internal error leaked to the client: %s", rec.Body)
	}
	if !strings.Contains(logs, "users_secret") || !strings.Contains(logs, `"level":"ERROR"`) {
		t.Fatalf("cause not logged: %s", logs)
	}
}

func TestCauseIsLoggedButNeverSent(t *testing.T) {
	t.Parallel()

	rec, logs := render(t.Context(), t, Internal().WithCause(errors.New("dial tcp 10.0.0.5:5432")))
	if strings.Contains(rec.Body.String(), "10.0.0.5") || !strings.Contains(logs, "10.0.0.5") {
		t.Fatalf("body %s / logs %s", rec.Body, logs)
	}
}

func TestSentinelsStillMatchAfterCopies(t *testing.T) {
	t.Parallel()

	err := fmt.Errorf("wrap: %w", errInsufficientFunds.WithDetail("x").WithCause(errors.New("y")))
	if !errors.Is(err, errInsufficientFunds) {
		t.Fatal("errors.Is lost the sentinel after WithDetail/WithCause")
	}
	if errors.Is(err, NotFound("Account")) {
		t.Fatal("matched a different problem")
	}
	if errInsufficientFunds.Detail != "" {
		t.Fatal("WithDetail mutated the shared sentinel")
	}
}

func TestWithFieldsDoesNotShareTheBackingArray(t *testing.T) {
	t.Parallel()

	base := Validation(Field("/a", "required", "A"))
	one := base.WithFields(Field("/b", "required", "B"))
	two := base.WithFields(Field("/c", "required", "C"))
	if one.Fields[1].Field != "/b" || two.Fields[1].Field != "/c" || len(base.Fields) != 1 {
		t.Fatalf("fields aliased: %+v %+v %+v", base.Fields, one.Fields, two.Fields)
	}
}

func TestRateLimitedSetsRetryAfterAndRetryAt(t *testing.T) {
	t.Parallel()

	at := time.Now().Add(90 * time.Second)
	rec, _ := render(t.Context(), t, RateLimited(at))
	p := decode(t, rec)
	secs, err := strconv.Atoi(rec.Header().Get("Retry-After"))
	if rec.Code != http.StatusTooManyRequests || err != nil || secs < 89 || secs > 90 {
		t.Fatalf("status %d Retry-After %q", rec.Code, rec.Header().Get("Retry-After"))
	}
	if p.RetryAt == nil || p.RetryAt.Sub(at).Abs() > time.Second {
		t.Fatalf("retry_at = %v, want %v", p.RetryAt, at)
	}
}

func TestPaidFeatureRequiredNamesTheFeature(t *testing.T) {
	t.Parallel()

	rec, _ := render(t.Context(), t, PaidFeatureRequired("international_transfers"))
	p := decode(t, rec)
	if rec.Code != http.StatusForbidden || p.Feature == nil || *p.Feature != "international_transfers" {
		t.Fatalf("got %d %+v", rec.Code, p)
	}
}

func TestDeadlineExceededIsA504(t *testing.T) {
	t.Parallel()

	rec, _ := render(t.Context(), t, fmt.Errorf("query: %w", context.DeadlineExceeded))
	if rec.Code != http.StatusGatewayTimeout || decode(t, rec).Code != CodeTimeout {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
}

func TestACanceledClientGetsNoBodyAndNoErrorLog(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	rec, logs := render(ctx, t, fmt.Errorf("query: %w", context.Canceled))
	if rec.Body.Len() != 0 || strings.Contains(logs, `"level":"ERROR"`) {
		t.Fatalf("body %q logs %s", rec.Body, logs)
	}
}

func TestErrorStringCarriesCodeDetailAndCause(t *testing.T) {
	t.Parallel()

	got := errInsufficientFunds.WithDetail("NGN").WithCause(errors.New("db")).Error()
	if got != "insufficient_funds: Not enough money. (NGN): db" {
		t.Fatalf("Error() = %q", got)
	}
}
