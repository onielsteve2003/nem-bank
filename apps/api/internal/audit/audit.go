// Package audit is the tamper-evident audit log (ADM-9): an append-only, hash-chained
// record of security and staff actions.
//
// Each entry's hash is hex(SHA-256(prev_hash + canonical JSON of the entry without its
// hash)), with prev_hash "000…0" for the first. Canonical JSON is the console's
// (apps/console/src/data/mock/audit.ts): keys sorted, no spaces, strings and numbers as
// JavaScript's JSON.stringify writes them. So the console's verify and this package's
// agree on every hash, and editing, deleting or reordering any row breaks every hash
// after it.
package audit

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/audit/auditdb"
)

// GenesisHash is the prev_hash of the first entry.
var GenesisHash = strings.Repeat("0", 64)

// Actor types (contract AuditEntry.actor.type).
const (
	ActorStaff    = "staff"
	ActorCustomer = "customer"
	ActorSystem   = "system"
)

// Actor is who did it. Customers are recorded by ID only: no names in the log.
type Actor struct {
	Type string
	ID   *string
	Name *string
}

// Customer is a customer actor.
func Customer(id uuid.UUID) Actor { s := id.String(); return Actor{Type: ActorCustomer, ID: &s} }

// System is the bank itself (jobs, automatic responses).
func System() Actor { return Actor{Type: ActorSystem} }

// Input is an entry to append.
type Input struct {
	Actor        Actor
	Action       string // "device.revoke", "kyc.approve", ...
	ResourceType string
	ResourceID   string
	// Metadata holds IDs and codes, never PII. Integers stay exact; keep amounts as
	// strings of minor units, as the API does.
	Metadata map[string]any
	IP       *string
}

// Entry is a stored entry.
type Entry struct {
	Seq          int64
	ID           uuid.UUID
	At           time.Time
	Actor        Actor
	Action       string
	ResourceType string
	ResourceID   string
	Metadata     json.RawMessage
	IP           *string
	PrevHash     string
	Hash         string
}

// timeLayout is JavaScript's toISOString: milliseconds, always UTC.
const timeLayout = "2006-01-02T15:04:05.000Z"

// Append adds an entry inside the caller's transaction, so it commits or rolls back with
// the action it records. Appends are serialised by a transaction-scoped advisory lock:
// each needs the head's hash. Audited actions are rare (security changes, staff
// decisions), so one at a time costs little.
func Append(ctx context.Context, tx pgx.Tx, in Input, now time.Time) (Entry, error) {
	if in.Actor.Type == "" || in.Action == "" || in.ResourceType == "" || in.ResourceID == "" {
		return Entry{}, errors.New("audit: actor, action and resource are required")
	}
	q := auditdb.New(tx)
	if err := q.LockAuditChain(ctx); err != nil {
		return Entry{}, fmt.Errorf("audit: lock chain: %w", err)
	}
	e := Entry{
		Seq: 1, PrevHash: GenesisHash, At: now.UTC().Truncate(time.Millisecond),
		Actor: in.Actor, Action: in.Action, ResourceType: in.ResourceType, ResourceID: in.ResourceID, IP: in.IP,
	}
	head, err := q.GetAuditHead(ctx)
	switch {
	case err == nil:
		e.Seq, e.PrevHash = head.Seq+1, head.Hash
	case !errors.Is(err, pgx.ErrNoRows):
		return Entry{}, fmt.Errorf("audit: read head: %w", err)
	}
	if e.ID, err = uuid.NewV7(); err != nil {
		return Entry{}, fmt.Errorf("audit: id: %w", err)
	}
	meta := in.Metadata
	if meta == nil {
		meta = map[string]any{}
	}
	raw, err := json.Marshal(meta)
	if err != nil {
		return Entry{}, fmt.Errorf("audit: metadata: %w", err)
	}
	// Stored in its canonical form, so what jsonb gives back canonicalises to the same text.
	if e.Metadata, err = canonicalJSON(raw); err != nil {
		return Entry{}, err
	}
	if e.Hash, err = HashEntry(e); err != nil {
		return Entry{}, err
	}
	err = q.InsertAuditEntry(ctx, auditdb.InsertAuditEntryParams{
		Seq: e.Seq, ID: e.ID, At: e.At, ActorType: e.Actor.Type, ActorID: e.Actor.ID, ActorName: e.Actor.Name,
		Action: e.Action, ResourceType: e.ResourceType, ResourceID: e.ResourceID, Metadata: e.Metadata,
		Ip: e.IP, PrevHash: e.PrevHash, Hash: e.Hash,
	})
	if err != nil {
		return Entry{}, fmt.Errorf("audit: insert: %w", err)
	}
	return e, nil
}

// HashEntry is the entry's chain hash: hex(SHA-256(prev_hash + canonical entry)).
func HashEntry(e Entry) (string, error) {
	var meta any
	dec := json.NewDecoder(bytes.NewReader(e.Metadata))
	dec.UseNumber()
	if err := dec.Decode(&meta); err != nil {
		return "", fmt.Errorf("audit: metadata: %w", err)
	}
	doc := map[string]any{
		"seq":       json.Number(fmt.Sprint(e.Seq)),
		"id":        e.ID.String(),
		"at":        e.At.UTC().Format(timeLayout),
		"actor":     map[string]any{"type": e.Actor.Type, "id": strOrNil(e.Actor.ID), "name": strOrNil(e.Actor.Name)},
		"action":    e.Action,
		"resource":  map[string]any{"type": e.ResourceType, "id": e.ResourceID},
		"metadata":  meta,
		"ip":        strOrNil(e.IP),
		"prev_hash": e.PrevHash,
	}
	var b strings.Builder
	b.WriteString(e.PrevHash)
	if err := writeCanonical(&b, doc); err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:]), nil
}

func strOrNil(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// Verification is the result of checking a range of the chain (contract AuditVerification).
type Verification struct {
	Valid          bool
	Checked        int64
	FirstBrokenSeq *int64
	HeadSeq        int64
	HeadHash       string
}

// verifyPage bounds the rows held in memory while verifying.
const verifyPage = 500

// Verify recomputes every hash from fromSeq to toSeq (0 means the head) and stops at the
// first entry whose sequence, link or hash does not match, like the console's verify.
func Verify(ctx context.Context, db auditdb.DBTX, fromSeq, toSeq int64) (Verification, error) {
	q := auditdb.New(db)
	out := Verification{Valid: true, HeadHash: GenesisHash}
	head, err := q.GetAuditHead(ctx)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return out, nil
	case err != nil:
		return Verification{}, fmt.Errorf("audit: read head: %w", err)
	}
	out.HeadSeq, out.HeadHash = head.Seq, head.Hash
	fromSeq = max(fromSeq, 1)
	if toSeq <= 0 || toSeq > head.Seq {
		toSeq = head.Seq
	}

	broken := func(seq int64) (Verification, error) {
		out.Valid, out.FirstBrokenSeq = false, &seq
		out.Checked = seq - fromSeq
		return out, nil
	}
	prev := GenesisHash
	if fromSeq > 1 {
		h, err := q.GetAuditHash(ctx, fromSeq-1)
		if errors.Is(err, pgx.ErrNoRows) {
			return broken(fromSeq)
		}
		if err != nil {
			return Verification{}, fmt.Errorf("audit: read hash: %w", err)
		}
		prev = h
	}
	next := fromSeq
	for next <= toSeq {
		rows, err := q.ListAuditRange(ctx, auditdb.ListAuditRangeParams{FromSeq: next, ToSeq: toSeq, N: verifyPage})
		if err != nil {
			return Verification{}, fmt.Errorf("audit: read range: %w", err)
		}
		if len(rows) == 0 {
			return broken(next) // rows deleted from the end of the range
		}
		for _, r := range rows {
			e := entryOf(r)
			if e.Seq != next || e.PrevHash != prev {
				return broken(next)
			}
			if h, err := HashEntry(e); err != nil || h != e.Hash {
				return broken(next)
			}
			prev, next = e.Hash, next+1
		}
	}
	out.Checked = toSeq - fromSeq + 1
	return out, nil
}

func entryOf(r auditdb.AuditLog) Entry {
	return Entry{
		Seq: r.Seq, ID: r.ID, At: r.At, Actor: Actor{Type: r.ActorType, ID: r.ActorID, Name: r.ActorName},
		Action: r.Action, ResourceType: r.ResourceType, ResourceID: r.ResourceID,
		Metadata: r.Metadata, IP: r.Ip, PrevHash: r.PrevHash, Hash: r.Hash,
	}
}
