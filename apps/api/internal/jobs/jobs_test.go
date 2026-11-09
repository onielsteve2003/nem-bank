package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

func noop(context.Context, Delivery) error { return nil }

func newRunner(t *testing.T, pool *pgxpool.Pool, subs ...Subscriber) *Runner {
	t.Helper()
	r, err := New(pool, quiet, Options{Subscribers: subs, DispatchInterval: 20 * time.Millisecond})
	if err != nil {
		t.Fatalf("new runner: %v", err)
	}
	return r
}

func writeEvent(t *testing.T, pool *pgxpool.Pool, topic string, commit bool) uuid.UUID {
	t.Helper()
	ctx := t.Context()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	id, err := Write(ctx, tx, Event{Topic: topic, AggregateType: "transfer", AggregateID: "tr_1", Payload: map[string]string{"amount_minor": "150000"}})
	if err != nil {
		t.Fatalf("write: %v", err)
	}
	if commit {
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	return id
}

func count(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(t.Context(), sql, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	return n
}

const deliveriesSQL = "SELECT count(*) FROM river_job WHERE kind = 'outbox_delivery'"

func TestWriteRejectsUndeliverableEvents(t *testing.T) {
	t.Parallel()

	tests := []Event{
		{Topic: "Transfer Completed", AggregateType: "transfer", AggregateID: "1"},
		{Topic: "transfer", AggregateType: "transfer", AggregateID: "1"},
		{Topic: "transfer.completed", AggregateID: "1"},
		{Topic: "transfer.completed", AggregateType: "transfer", AggregateID: "1", Payload: make(chan int)},
	}
	for _, ev := range tests {
		// The DB is never reached, so a nil DBTX proves validation happens first.
		if _, err := Write(t.Context(), nil, ev); !errors.Is(err, ErrInvalidEvent) {
			t.Errorf("Write(%+v) err = %v, want ErrInvalidEvent", ev, err)
		}
	}
}

func TestNewRejectsBadSubscribers(t *testing.T) {
	t.Parallel()

	tests := map[string][]Subscriber{
		"no handler":   {{Name: "a", Topics: []string{"x.y"}}},
		"no topics":    {{Name: "a", Handle: noop}},
		"bad topic":    {{Name: "a", Topics: []string{"x"}, Handle: noop}},
		"two the same": {{Name: "a", Topics: []string{"x.y"}, Handle: noop}, {Name: "a", Topics: []string{"x.z"}, Handle: noop}},
	}
	for name, subs := range tests {
		if _, err := New(nil, quiet, Options{Subscribers: subs}); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

func TestRolledBackEventIsNeverDispatched(t *testing.T) {
	t.Parallel()
	pool := testdb.New(t)
	r := newRunner(t, pool, Subscriber{Name: "push", Topics: []string{"transfer.completed"}, Handle: noop})

	writeEvent(t, pool, "transfer.completed", false)
	n, err := r.Dispatcher().DispatchOnce(t.Context())
	if err != nil || n != 0 {
		t.Fatalf("DispatchOnce = %d, %v; want 0 events", n, err)
	}
	if got := count(t, pool, "SELECT count(*) FROM outbox_events"); got != 0 {
		t.Fatalf("outbox has %d rows after rollback", got)
	}
}

func TestDispatchFansOutPerSubscriberAndOnlyOnce(t *testing.T) {
	t.Parallel()
	pool := testdb.New(t)
	r := newRunner(t, pool,
		Subscriber{Name: "push", Topics: []string{"transfer.completed"}, Handle: noop},
		Subscriber{Name: "webhooks", Topics: []string{"transfer.completed", "card.frozen"}, Handle: noop},
	)

	writeEvent(t, pool, "transfer.completed", true) // two subscribers
	writeEvent(t, pool, "card.frozen", true)        // one subscriber
	writeEvent(t, pool, "kyc.approved", true)       // none: dispatched, no jobs

	n, err := r.Dispatcher().DispatchOnce(t.Context())
	if err != nil || n != 3 {
		t.Fatalf("DispatchOnce = %d, %v; want 3", n, err)
	}
	if got := count(t, pool, deliveriesSQL); got != 3 {
		t.Fatalf("queued %d deliveries, want 3", got)
	}
	if got := count(t, pool, "SELECT count(*) FROM outbox_events WHERE dispatched_at IS NULL"); got != 0 {
		t.Fatalf("%d events still pending", got)
	}

	n, err = r.Dispatcher().DispatchOnce(t.Context())
	if err != nil || n != 0 || count(t, pool, deliveriesSQL) != 3 {
		t.Fatalf("second dispatch re-queued work: n=%d err=%v", n, err)
	}
}

func TestConcurrentDispatchersNeverDoubleDispatch(t *testing.T) {
	t.Parallel()
	pool := testdb.New(t)
	sub := Subscriber{Name: "push", Topics: []string{"transfer.completed"}, Handle: noop}
	const events = 60
	for range events {
		writeEvent(t, pool, "transfer.completed", true)
	}

	// Small batches and several dispatchers (as if several instances) race for the rows.
	var wg sync.WaitGroup
	var mu sync.Mutex
	total := 0
	for range 4 {
		d := newRunner(t, pool, sub).Dispatcher()
		d.batchSize = 7
		wg.Go(func() {
			for {
				n, err := d.DispatchOnce(t.Context())
				if err != nil {
					t.Errorf("dispatch: %v", err)
					return
				}
				if n == 0 {
					return
				}
				mu.Lock()
				total += n
				mu.Unlock()
			}
		})
	}
	wg.Wait()

	if total != events || count(t, pool, deliveriesSQL) != events {
		t.Fatalf("dispatched %d, queued %d; want %d each", total, count(t, pool, deliveriesSQL), events)
	}
}

func TestRunningRunnerDeliversCommittedEvents(t *testing.T) {
	t.Parallel()
	pool := testdb.New(t)
	got := make(chan Delivery, 1)
	r := newRunner(t, pool, Subscriber{
		Name: "push", Topics: []string{"transfer.completed"},
		Handle: func(_ context.Context, d Delivery) error { got <- d; return nil },
	})
	if err := r.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := r.Stop(ctx); err != nil {
			t.Errorf("stop: %v", err)
		}
	})

	id := writeEvent(t, pool, "transfer.completed", true)
	select {
	case d := <-got:
		var payload map[string]string
		if err := json.Unmarshal(d.Payload, &payload); err != nil {
			t.Fatalf("payload: %v", err)
		}
		if d.ID != id || d.AggregateID != "tr_1" || payload["amount_minor"] != "150000" {
			t.Fatalf("unexpected delivery: %+v", d)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("event was not delivered")
	}
}

func TestPruneDeletesOnlyOldDispatchedEvents(t *testing.T) {
	t.Parallel()
	pool := testdb.New(t)
	ctx := t.Context()

	old := writeEvent(t, pool, "transfer.completed", true)
	recent := writeEvent(t, pool, "transfer.completed", true)
	pending := writeEvent(t, pool, "transfer.completed", true)
	exec := func(sql string, args ...any) {
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec("UPDATE outbox_events SET dispatched_at = now() - interval '8 days' WHERE id = $1", old)
	exec("UPDATE outbox_events SET dispatched_at = now() - interval '1 day' WHERE id = $1", recent)

	n, err := Prune(ctx, pool, time.Now().Add(-7*24*time.Hour))
	if err != nil || n != 1 {
		t.Fatalf("Prune = %d, %v; want 1", n, err)
	}
	var left []uuid.UUID
	rows, _ := pool.Query(ctx, "SELECT id FROM outbox_events ORDER BY id")
	left, err = pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil || len(left) != 2 || left[0] != recent || left[1] != pending {
		t.Fatalf("left %v (err %v), want recent and pending", left, err)
	}
}
