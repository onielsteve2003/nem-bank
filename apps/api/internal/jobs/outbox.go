// Package jobs runs background work on River (a Postgres-backed job queue, in-process
// because Render's free tier has no worker dynos) and owns the transactional outbox.
//
// The flow for any side effect of a state change (a push, an email, a webhook):
//
//  1. The domain calls Write inside the same transaction as its state change. The event
//     exists if and only if the change committed: no lost events, no ghost events.
//  2. The Dispatcher claims pending events and, in one transaction, inserts one River job
//     per (event, subscriber) and marks the events dispatched.
//  3. River runs each job with retries and backoff. Delivery is at-least-once, so every
//     Subscriber must be idempotent on Delivery.ID.
package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs/jobsdb"
)

// Event is a fact a domain publishes, e.g. topic "transfer.completed" for aggregate
// ("transfer", "<id>"). Payloads carry IDs and amounts, never PII: they are stored and
// may be logged on failure.
type Event struct {
	Topic         string
	AggregateType string
	AggregateID   string
	Payload       any
}

// validTopic mirrors the outbox_events CHECK constraint: dotted lowercase segments.
var validTopic = regexp.MustCompile(`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`)

// ErrInvalidEvent is returned for an event that would never be deliverable.
var ErrInvalidEvent = errors.New("invalid outbox event")

// Write records ev in the outbox. tx must be the caller's domain transaction (a pgx.Tx):
// writing through the pool directly would break the guarantee this table exists for.
func Write(ctx context.Context, tx jobsdb.DBTX, ev Event) (uuid.UUID, error) {
	if !validTopic.MatchString(ev.Topic) || ev.AggregateType == "" || ev.AggregateID == "" {
		return uuid.Nil, fmt.Errorf("%w: topic %q, aggregate %q/%q", ErrInvalidEvent, ev.Topic, ev.AggregateType, ev.AggregateID)
	}
	payload, err := json.Marshal(ev.Payload)
	if err != nil {
		return uuid.Nil, fmt.Errorf("%w: payload: %w", ErrInvalidEvent, err)
	}
	// UUIDv7 is time-ordered, so the primary key index stays append-only.
	id, err := uuid.NewV7()
	if err != nil {
		return uuid.Nil, fmt.Errorf("outbox event id: %w", err)
	}
	err = jobsdb.New(tx).InsertOutboxEvent(ctx, jobsdb.InsertOutboxEventParams{
		ID: id, Topic: ev.Topic, AggregateType: ev.AggregateType, AggregateID: ev.AggregateID, Payload: payload,
	})
	if err != nil {
		return uuid.Nil, fmt.Errorf("write outbox event: %w", err)
	}
	return id, nil
}
