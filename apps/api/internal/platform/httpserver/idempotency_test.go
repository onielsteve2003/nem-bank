package httpserver

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/idempotency"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

// alwaysRun is a store that lets every request run, for tests about other middleware.
type alwaysRun struct{}

func (alwaysRun) Begin(_ context.Context, scope string, key uuid.UUID, _ []byte) (*idempotency.Claim, *idempotency.Response, error) {
	return &idempotency.Claim{Scope: scope, Key: key}, nil, nil
}
func (alwaysRun) Complete(context.Context, *idempotency.Claim, idempotency.Response) (bool, error) {
	return true, nil
}
func (alwaysRun) Release(context.Context, *idempotency.Claim) error { return nil }

// keyedEngine mounts runIdempotent in front of a handler that counts its runs and
// answers with status, as a money endpoint would.
func keyedEngine(t *testing.T, store IdempotencyStore, status *atomic.Int32, gate chan struct{}) (*gin.Engine, *atomic.Int32) {
	t.Helper()
	runs := &atomic.Int32{}
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	r := gin.New()
	r.POST("/v1/transfers", func(c *gin.Context) {
		user, _ := uuid.Parse(c.GetHeader("X-Test-User"))
		c.Request = c.Request.WithContext(identity.WithPrincipal(c.Request.Context(), identity.Principal{UserID: user}))
		body, _ := io.ReadAll(c.Request.Body)
		runIdempotent(c, store, body, quiet)
	}, func(c *gin.Context) {
		n := runs.Add(1)
		if gate != nil {
			<-gate
		}
		c.JSON(int(status.Load()), gin.H{"run": n})
	})
	return r, runs
}

func keyedPost(h http.Handler, user, key uuid.UUID, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/v1/transfers", bytes.NewBufferString(body))
	req.Header.Set("Idempotency-Key", key.String())
	req.Header.Set("X-Test-User", user.String())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestARetriedMoneyRequestRunsOnceAndReplays(t *testing.T) {
	t.Parallel()
	status := &atomic.Int32{}
	status.Store(http.StatusCreated)
	h, runs := keyedEngine(t, idempotency.NewStore(testdb.New(t)), status, nil)
	tolu, emeka, key := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())

	first := keyedPost(h, tolu, key, `{"amount":"1"}`)
	again := keyedPost(h, tolu, key, `{"amount":"1"}`)
	if first.Code != http.StatusCreated || again.Code != http.StatusCreated || again.Body.String() != first.Body.String() {
		t.Fatalf("first %d %s, retry %d %s", first.Code, first.Body, again.Code, again.Body)
	}
	if again.Header().Get(ReplayedHeader) != "true" || first.Header().Get(ReplayedHeader) != "" {
		t.Fatal("only the replay is marked replayed")
	}
	if again.Header().Get("Content-Type") != first.Header().Get("Content-Type") {
		t.Fatalf("replayed content type %q", again.Header().Get("Content-Type"))
	}
	if rec := keyedPost(h, tolu, key, `{"amount":"2"}`); rec.Code != http.StatusUnprocessableEntity ||
		decodeProblem(t, rec).Code != "idempotency_conflict" {
		t.Fatalf("same key, other body = %d %s", rec.Code, rec.Body)
	}
	// Another customer's request under the same key is theirs alone.
	if rec := keyedPost(h, emeka, key, `{"amount":"1"}`); rec.Code != http.StatusCreated || rec.Header().Get(ReplayedHeader) != "" {
		t.Fatalf("other user = %d", rec.Code)
	}
	if runs.Load() != 2 {
		t.Fatalf("handler ran %d times, want 2", runs.Load())
	}
}

func TestAServerErrorIsNotRemembered(t *testing.T) {
	t.Parallel()
	status := &atomic.Int32{}
	status.Store(http.StatusServiceUnavailable)
	h, runs := keyedEngine(t, idempotency.NewStore(testdb.New(t)), status, nil)
	user, key := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	if rec := keyedPost(h, user, key, "{}"); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d", rec.Code)
	}
	status.Store(http.StatusCreated)
	if rec := keyedPost(h, user, key, "{}"); rec.Code != http.StatusCreated || rec.Header().Get(ReplayedHeader) != "" {
		t.Fatalf("retry after 503 = %d", rec.Code)
	}
	if runs.Load() != 2 {
		t.Fatalf("runs = %d", runs.Load())
	}
}

// A double tap: the second request arrives while the first is still running.
func TestConcurrentDuplicatesRunOnce(t *testing.T) {
	t.Parallel()
	status := &atomic.Int32{}
	status.Store(http.StatusCreated)
	gate := make(chan struct{})
	h, runs := keyedEngine(t, idempotency.NewStore(testdb.New(t)), status, gate)
	user, key := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())

	var wg sync.WaitGroup
	results := make(chan *httptest.ResponseRecorder, 1)
	wg.Go(func() { results <- keyedPost(h, user, key, "{}") })
	for runs.Load() == 0 { // wait until the first request is inside the handler
		runtime.Gosched()
	}
	dup := keyedPost(h, user, key, "{}")
	close(gate)
	wg.Wait()
	if first := <-results; first.Code != http.StatusCreated {
		t.Fatalf("first = %d", first.Code)
	}
	if dup.Code != http.StatusConflict || dup.Header().Get("Retry-After") == "" {
		t.Fatalf("in-flight duplicate = %d %v", dup.Code, dup.Header())
	}
	if runs.Load() != 1 {
		t.Fatalf("runs = %d, want 1", runs.Load())
	}
}

func TestKeyedRequestsAreRefusedWithoutAStore(t *testing.T) {
	t.Parallel()
	status := &atomic.Int32{}
	status.Store(http.StatusCreated)
	h, runs := keyedEngine(t, nil, status, nil)
	if rec := keyedPost(h, uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7()), "{}"); rec.Code != http.StatusInternalServerError || runs.Load() != 0 {
		t.Fatalf("got %d, runs %d", rec.Code, runs.Load())
	}
}
