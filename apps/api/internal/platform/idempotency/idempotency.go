// Package idempotency stores Idempotency-Key claims and responses, so a money-moving
// request runs once however often the client retries it (TRF-5: a double tap never
// double-debits). The HTTP middleware lives in httpserver; this package is the storage.
//
// A key moves through three states:
//
//	claimed (in progress) ──handler answered <500──▶ completed: replayed to every retry
//	        └─────────────handler failed (5xx/429)──▶ dropped: the retry runs afresh
//
// A server that dies mid-request leaves its claim behind; once the lease runs out, a
// retry of the same request takes the key over. If the first run had already committed,
// the ledger's own unique entry key (journal_entries.idempotency_key) stops a second
// posting, so the takeover is safe.
package idempotency

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/database/platformdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

const (
	// Retain is how long a key is remembered. The app retries within seconds; a day
	// covers a phone that comes back online the next morning.
	Retain = 24 * time.Hour
	// Lease is how long a claim blocks the key before a retry may take it over. It is
	// longer than the server's 30 s write timeout, so a live request is never overtaken.
	Lease = time.Minute
)

// Problems a client sees. The codes are the contract's (Problem.code).
var (
	// ErrKeyReused: the key was used for a different request (contract: 422).
	ErrKeyReused = problem.New(http.StatusUnprocessableEntity, problem.CodeIdempotencyConflict,
		"This Idempotency-Key was already used for a different request. Send a new key.")
	// ErrInProgress: the first request with this key has not finished yet.
	ErrInProgress = problem.New(http.StatusConflict, problem.CodeConflict,
		"A request with this Idempotency-Key is still being processed. Try again in a moment.")
)

// Hash is the request fingerprint stored with a key: method, target (path and query) and
// the body bytes exactly as sent, so the same key on another endpoint is refused too.
func Hash(method, target string, body []byte) []byte {
	h := sha256.New()
	h.Write([]byte(method + "\n" + target + "\n"))
	h.Write(body)
	return h.Sum(nil)
}

// Response is a stored answer.
type Response struct {
	Status      int
	ContentType string
	Body        []byte
}

// Claim is the right to run a request; only its holder may Complete or Release the key.
type Claim struct {
	Scope    string
	Key      uuid.UUID
	lockedAt time.Time
}

// Store keeps keys in Postgres.
type Store struct {
	db platformdb.DBTX
}

// NewStore returns a store on db (the pool).
func NewStore(db platformdb.DBTX) *Store { return &Store{db: db} }

// Begin claims key for a request. It returns the claim when the request should run, or
// the stored response when an earlier run with the same request already answered. A
// different request under the key is ErrKeyReused; one still running is ErrInProgress.
func (s *Store) Begin(ctx context.Context, scope string, key uuid.UUID, hash []byte) (*Claim, *Response, error) {
	q := platformdb.New(s.db)
	lockedAt, err := q.ClaimIdempotencyKey(ctx, platformdb.ClaimIdempotencyKeyParams{
		Scope: scope, Key: key, RequestHash: hash,
		RetainSeconds: Retain.Seconds(), LeaseSeconds: Lease.Seconds(),
	})
	if err == nil {
		return &Claim{Scope: scope, Key: key, lockedAt: lockedAt}, nil, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, fmt.Errorf("claim idempotency key: %w", err)
	}
	row, err := q.GetIdempotencyKey(ctx, platformdb.GetIdempotencyKeyParams{Scope: scope, Key: key})
	if errors.Is(err, pgx.ErrNoRows) {
		// The holder released it between the two statements; the client simply retries.
		return nil, nil, ErrInProgress
	}
	if err != nil {
		return nil, nil, fmt.Errorf("read idempotency key: %w", err)
	}
	switch {
	case string(row.RequestHash) != string(hash):
		return nil, nil, ErrKeyReused
	case row.Status != "completed":
		return nil, nil, ErrInProgress
	}
	return nil, &Response{
		Status: int(row.ResponseStatus.Int32), ContentType: row.ResponseContentType.String, Body: row.ResponseBody,
	}, nil
}

// Complete stores the response for retries. It reports false when the claim was lost
// (its lease ran out and a retry took over), in which case nothing was stored.
func (s *Store) Complete(ctx context.Context, c *Claim, r Response) (bool, error) {
	n, err := platformdb.New(s.db).CompleteIdempotencyKey(ctx, platformdb.CompleteIdempotencyKeyParams{
		ResponseStatus:      pgtype.Int4{Int32: int32(min(max(r.Status, 0), 999)), Valid: true}, //nolint:gosec // clamped to an HTTP status
		ResponseContentType: pgtype.Text{String: r.ContentType, Valid: r.ContentType != ""},
		ResponseBody:        r.Body,
		Scope:               c.Scope, Key: c.Key, LockedAt: c.lockedAt,
	})
	if err != nil {
		return false, fmt.Errorf("complete idempotency key: %w", err)
	}
	return n == 1, nil
}

// Release drops the claim so the client's retry runs afresh.
func (s *Store) Release(ctx context.Context, c *Claim) error {
	if err := platformdb.New(s.db).ReleaseIdempotencyKey(ctx, platformdb.ReleaseIdempotencyKeyParams{
		Scope: c.Scope, Key: c.Key, LockedAt: c.lockedAt,
	}); err != nil {
		return fmt.Errorf("release idempotency key: %w", err)
	}
	return nil
}

// Prune deletes keys older than Retain. Expired keys are overwritten on reuse anyway;
// pruning only keeps the table small. It runs with the hourly jobs housekeeping.
func (s *Store) Prune(ctx context.Context) error {
	if _, err := platformdb.New(s.db).PruneIdempotencyKeys(ctx, time.Now().Add(-Retain)); err != nil {
		return fmt.Errorf("prune idempotency keys: %w", err)
	}
	return nil
}
