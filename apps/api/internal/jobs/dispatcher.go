package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs/jobsdb"
)

// Delivery is one outbox event handed to a subscriber.
type Delivery struct {
	// ID is the outbox event ID: the idempotency key for subscribers.
	ID            uuid.UUID       `json:"id"`
	Topic         string          `json:"topic"`
	AggregateType string          `json:"aggregate_type"`
	AggregateID   string          `json:"aggregate_id"`
	Payload       json.RawMessage `json:"payload"`
	CreatedAt     time.Time       `json:"created_at"`
}

// Subscriber reacts to outbox events on its topics. Handle runs inside a River job: return
// an error to retry with backoff, river.JobCancel(err) to give up for good.
type Subscriber struct {
	// Name identifies the subscriber in jobs; renaming one orphans its queued deliveries.
	Name   string
	Topics []string
	Handle func(ctx context.Context, d Delivery) error
}

// DeliverArgs is the River job for one (event, subscriber) pair.
type DeliverArgs struct {
	// EventID and Subscriber make the job unique: re-dispatching an event can never queue
	// the same delivery twice.
	EventID    uuid.UUID `json:"event_id" river:"unique"`
	Subscriber string    `json:"subscriber" river:"unique"`
	Delivery   Delivery  `json:"delivery"`
}

// Kind implements river.JobArgs.
func (DeliverArgs) Kind() string { return "outbox_delivery" }

// InsertOpts implements river.JobArgsWithInsertOpts.
func (DeliverArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{UniqueOpts: river.UniqueOpts{ByArgs: true}}
}

type deliverWorker struct {
	river.WorkerDefaults[DeliverArgs]
	subscribers map[string]Subscriber
}

func (w *deliverWorker) Work(ctx context.Context, job *river.Job[DeliverArgs]) error {
	sub, ok := w.subscribers[job.Args.Subscriber]
	if !ok {
		// Retrying cannot help: the subscriber was removed from the code.
		return river.JobCancel(fmt.Errorf("no subscriber named %q", job.Args.Subscriber))
	}
	if err := sub.Handle(ctx, job.Args.Delivery); err != nil {
		return fmt.Errorf("subscriber %s, event %s: %w", sub.Name, job.Args.EventID, err)
	}
	return nil
}

// Dispatcher moves committed outbox events into River jobs.
type Dispatcher struct {
	pool      *pgxpool.Pool
	river     *river.Client[pgx.Tx]
	log       *slog.Logger
	byTopic   map[string][]string // topic -> subscriber names
	batchSize int32
	interval  time.Duration
}

// DispatchOnce claims up to one batch of pending events and enqueues their deliveries. It
// returns how many events it dispatched. Claiming, enqueueing and marking share one
// transaction, so a crash at any point leaves the batch pending for the next run.
func (d *Dispatcher) DispatchOnce(ctx context.Context) (int, error) {
	tx, err := d.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("begin dispatch: %w", err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }() // no-op after commit

	q := jobsdb.New(tx)
	events, err := q.ClaimPendingOutboxEvents(ctx, d.batchSize)
	if err != nil {
		return 0, fmt.Errorf("claim outbox events: %w", err)
	}
	if len(events) == 0 {
		return 0, nil
	}

	ids := make([]uuid.UUID, 0, len(events))
	var params []river.InsertManyParams
	for _, ev := range events {
		ids = append(ids, ev.ID)
		delivery := Delivery{
			ID: ev.ID, Topic: ev.Topic, AggregateType: ev.AggregateType,
			AggregateID: ev.AggregateID, Payload: ev.Payload, CreatedAt: ev.CreatedAt,
		}
		// An event nobody subscribes to is still marked dispatched: it was published, and
		// leaving it pending would make every run re-read it.
		for _, name := range d.byTopic[ev.Topic] {
			params = append(params, river.InsertManyParams{
				Args: DeliverArgs{EventID: ev.ID, Subscriber: name, Delivery: delivery},
			})
		}
	}
	if len(params) > 0 {
		if _, err := d.river.InsertManyTx(ctx, tx, params); err != nil {
			return 0, fmt.Errorf("enqueue deliveries: %w", err)
		}
	}
	if err := q.MarkOutboxEventsDispatched(ctx, ids); err != nil {
		return 0, fmt.Errorf("mark dispatched: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit dispatch: %w", err)
	}
	return len(events), nil
}

// Run dispatches until ctx is cancelled. A full batch means more may be waiting, so it
// loops straight away; otherwise it waits one interval. Errors are logged and retried:
// the outbox keeps every event until a dispatch commits.
func (d *Dispatcher) Run(ctx context.Context) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		n, err := d.DispatchOnce(ctx)
		switch {
		case err != nil && !errors.Is(err, context.Canceled):
			d.log.ErrorContext(ctx, "outbox dispatch failed", slog.Any("error", err))
			timer.Reset(d.interval)
		case n == int(d.batchSize):
			timer.Reset(0)
		default:
			timer.Reset(d.interval)
		}
	}
}
