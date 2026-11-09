package idempotency

import (
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

func TestAKeyRunsOnceThenReplaysItsResponse(t *testing.T) {
	t.Parallel()
	pool := testdb.New(t)
	s, ctx := NewStore(pool), t.Context()
	key, hash := uuid.Must(uuid.NewV7()), Hash("POST", "/v1/transfers", []byte(`{"a":1}`))

	claim, stored, err := s.Begin(ctx, "user:1", key, hash)
	if err != nil || claim == nil || stored != nil {
		t.Fatalf("first begin = %v %v %v", claim, stored, err)
	}
	// While the first run is in flight, a retry waits.
	if _, _, err := s.Begin(ctx, "user:1", key, hash); !errors.Is(err, ErrInProgress) {
		t.Fatalf("in-flight retry err = %v", err)
	}
	if ok, err := s.Complete(ctx, claim, Response{Status: 201, ContentType: "application/json", Body: []byte(`{"id":"t1"}`)}); !ok || err != nil {
		t.Fatalf("complete = %v %v", ok, err)
	}
	_, stored, err = s.Begin(ctx, "user:1", key, hash)
	if err != nil || stored == nil || stored.Status != 201 || string(stored.Body) != `{"id":"t1"}` || stored.ContentType != "application/json" {
		t.Fatalf("replay = %+v %v", stored, err)
	}
	// A different body, or the same body on another endpoint, under the key is refused.
	if _, _, err := s.Begin(ctx, "user:1", key, Hash("POST", "/v1/transfers", []byte(`{"a":2}`))); !errors.Is(err, ErrKeyReused) {
		t.Fatalf("other body err = %v", err)
	}
	if _, _, err := s.Begin(ctx, "user:1", key, Hash("POST", "/v1/fx/conversions", []byte(`{"a":1}`))); !errors.Is(err, ErrKeyReused) {
		t.Fatalf("other endpoint err = %v", err)
	}
	// Another caller's identical key is a separate key.
	if c, _, err := s.Begin(ctx, "user:2", key, hash); err != nil || c == nil {
		t.Fatalf("other scope = %v %v", c, err)
	}
}

func TestAReleasedKeyRunsAgain(t *testing.T) {
	t.Parallel()
	s, ctx := NewStore(testdb.New(t)), t.Context()
	key, hash := uuid.Must(uuid.NewV7()), Hash("POST", "/v1/transfers", nil)
	claim, _, err := s.Begin(ctx, "user:1", key, hash)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Release(ctx, claim); err != nil {
		t.Fatal(err)
	}
	if c, _, err := s.Begin(ctx, "user:1", key, hash); err != nil || c == nil {
		t.Fatalf("after release = %v %v", c, err)
	}
}

func TestAStaleClaimIsTakenOverOnlyByTheSameRequest(t *testing.T) {
	t.Parallel()
	pool := testdb.New(t)
	s, ctx := NewStore(pool), t.Context()
	key, hash := uuid.Must(uuid.NewV7()), Hash("POST", "/v1/transfers", []byte("x"))
	old, _, err := s.Begin(ctx, "user:1", key, hash)
	if err != nil {
		t.Fatal(err)
	}
	// The server running it died: its lease runs out.
	if _, err := pool.Exec(ctx, "UPDATE idempotency_keys SET locked_at = now() - interval '2 minutes'"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Begin(ctx, "user:1", key, Hash("POST", "/v1/transfers", []byte("y"))); !errors.Is(err, ErrKeyReused) {
		t.Fatalf("different request on a stale key: err = %v", err)
	}
	fresh, _, err := s.Begin(ctx, "user:1", key, hash)
	if err != nil || fresh == nil {
		t.Fatalf("takeover = %v %v", fresh, err)
	}
	// The old claim can no longer finish or drop the key.
	if ok, err := s.Complete(ctx, old, Response{Status: 201}); ok || err != nil {
		t.Fatalf("stale complete = %v %v", ok, err)
	}
	if err := s.Release(ctx, old); err != nil {
		t.Fatal(err)
	}
	if ok, err := s.Complete(ctx, fresh, Response{Status: 201}); !ok || err != nil {
		t.Fatalf("fresh complete = %v %v", ok, err)
	}
}

func TestExpiredKeysAreReusableAndPruned(t *testing.T) {
	t.Parallel()
	pool := testdb.New(t)
	s, ctx := NewStore(pool), t.Context()
	key := uuid.Must(uuid.NewV7())
	claim, _, err := s.Begin(ctx, "user:1", key, Hash("POST", "/a", nil))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Complete(ctx, claim, Response{Status: 201}); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "UPDATE idempotency_keys SET created_at = now() - interval '25 hours'"); err != nil {
		t.Fatal(err)
	}
	// Past retention the key is forgotten, even for a different request.
	if c, _, err := s.Begin(ctx, "user:1", key, Hash("POST", "/b", nil)); err != nil || c == nil {
		t.Fatalf("expired key reuse = %v %v", c, err)
	}
	if _, err := pool.Exec(ctx, "UPDATE idempotency_keys SET created_at = now() - interval '25 hours'"); err != nil {
		t.Fatal(err)
	}
	if err := s.Prune(ctx); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM idempotency_keys").Scan(&n); err != nil || n != 0 {
		t.Fatalf("after prune: %d rows, %v", n, err)
	}
}
