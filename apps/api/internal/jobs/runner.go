package jobs

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs/jobsdb"
)

// Options configure the Runner. Zero values get the defaults noted on each field.
type Options struct {
	Subscribers []Subscriber
	// MaxWorkers bounds concurrent jobs. Default 10: the pool is small on Neon's free tier.
	MaxWorkers int
	// DispatchInterval is the idle wait between outbox polls. Default 500 ms.
	DispatchInterval time.Duration
	// DispatchBatch is the most events one dispatch transaction claims. Default 100.
	DispatchBatch int32
	// RetainDispatched is how long dispatched events stay for debugging. Default 7 days.
	RetainDispatched time.Duration
}

// Runner owns the River client and the outbox dispatcher for the process.
type Runner struct {
	river      *river.Client[pgx.Tx]
	dispatcher *Dispatcher
	log        *slog.Logger

	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// New builds the runner. Nothing runs until Start.
func New(pool *pgxpool.Pool, log *slog.Logger, opts Options) (*Runner, error) {
	if opts.MaxWorkers <= 0 {
		opts.MaxWorkers = 10
	}
	if opts.DispatchInterval <= 0 {
		opts.DispatchInterval = 500 * time.Millisecond
	}
	if opts.DispatchBatch <= 0 {
		opts.DispatchBatch = 100
	}
	if opts.RetainDispatched <= 0 {
		opts.RetainDispatched = 7 * 24 * time.Hour
	}

	subs := make(map[string]Subscriber, len(opts.Subscribers))
	byTopic := map[string][]string{}
	for _, s := range opts.Subscribers {
		if s.Name == "" || s.Handle == nil || len(s.Topics) == 0 {
			return nil, fmt.Errorf("subscriber %q: needs a name, topics and a handler", s.Name)
		}
		if _, dup := subs[s.Name]; dup {
			return nil, fmt.Errorf("subscriber %q registered twice", s.Name)
		}
		subs[s.Name] = s
		for _, t := range s.Topics {
			if !validTopic.MatchString(t) {
				return nil, fmt.Errorf("subscriber %q: topic %q is not like \"transfer.completed\"", s.Name, t)
			}
			byTopic[t] = append(byTopic[t], s.Name)
		}
	}

	workers := river.NewWorkers()
	river.AddWorker(workers, &deliverWorker{subscribers: subs})
	river.AddWorker(workers, &pruneWorker{pool: pool, retain: opts.RetainDispatched})

	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Logger:  log.With("component", "river"),
		Queues:  map[string]river.QueueConfig{river.QueueDefault: {MaxWorkers: opts.MaxWorkers}},
		Workers: workers,
		PeriodicJobs: []*river.PeriodicJob{
			river.NewPeriodicJob(river.PeriodicInterval(time.Hour),
				func() (river.JobArgs, *river.InsertOpts) { return PruneArgs{}, nil },
				&river.PeriodicJobOpts{RunOnStart: true}),
		},
	})
	if err != nil {
		return nil, fmt.Errorf("river client: %w", err)
	}

	return &Runner{
		river: client,
		log:   log,
		dispatcher: &Dispatcher{
			pool: pool, river: client, log: log, byTopic: byTopic,
			batchSize: opts.DispatchBatch, interval: opts.DispatchInterval,
		},
	}, nil
}

// Client is the River client, for domains that enqueue jobs directly with InsertTx.
func (r *Runner) Client() *river.Client[pgx.Tx] { return r.river }

// Dispatcher is the outbox dispatcher, exposed for tests and manual drains.
func (r *Runner) Dispatcher() *Dispatcher { return r.dispatcher }

// Start begins working jobs and dispatching the outbox.
func (r *Runner) Start(ctx context.Context) error {
	if err := r.river.Start(ctx); err != nil {
		return fmt.Errorf("start river: %w", err)
	}
	dctx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	r.cancel = cancel
	r.wg.Go(func() { r.dispatcher.Run(dctx) })
	r.log.InfoContext(ctx, "jobs started")
	return nil
}

// Stop stops dispatching, then lets running jobs finish until ctx expires. Jobs cut off
// by the deadline are retried by River after restart.
func (r *Runner) Stop(ctx context.Context) error {
	if r.cancel != nil {
		r.cancel()
	}
	r.wg.Wait()
	if err := r.river.Stop(ctx); err != nil && !errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("stop river: %w", err)
	}
	return nil
}

// PruneArgs is the hourly job that deletes old dispatched outbox events.
type PruneArgs struct{}

// Kind implements river.JobArgs.
func (PruneArgs) Kind() string { return "outbox_prune" }

// InsertOpts implements river.JobArgsWithInsertOpts: one pending prune at a time, however
// many instances schedule it.
func (PruneArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{UniqueOpts: river.UniqueOpts{ByPeriod: time.Hour}}
}

type pruneWorker struct {
	river.WorkerDefaults[PruneArgs]
	pool   *pgxpool.Pool
	retain time.Duration
}

func (w *pruneWorker) Work(ctx context.Context, _ *river.Job[PruneArgs]) error {
	_, err := Prune(ctx, w.pool, time.Now().Add(-w.retain))
	return err
}

// Prune deletes events dispatched before cutoff, in batches, and returns how many went.
func Prune(ctx context.Context, db jobsdb.DBTX, cutoff time.Time) (int64, error) {
	const batch = 1000
	var total int64
	q := jobsdb.New(db)
	for {
		n, err := q.PruneDispatchedOutboxEvents(ctx, jobsdb.PruneDispatchedOutboxEventsParams{Before: cutoff, BatchSize: batch})
		if err != nil {
			return total, fmt.Errorf("prune outbox: %w", err)
		}
		total += n
		if n < batch {
			return total, nil
		}
	}
}
