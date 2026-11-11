package fx

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/fx/fxdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

// Ingest reads the rates once (FX-5). Sources are tried in order and the first usable
// reading is stored for every pair in one transaction, so the three pairs always share a
// timestamp. If every source fails the error goes back to River, which retries with
// backoff; until one succeeds, the last readings keep serving and age into "cache".
func (s *Service) Ingest(ctx context.Context) error {
	if len(s.sources) == 0 {
		return errors.New("fx: no rate sources configured")
	}
	var failures []error
	for _, src := range s.sources {
		snap, err := src.Fetch(ctx)
		if err == nil {
			err = s.store(ctx, snap)
		}
		if err == nil {
			// A failed check is not a failed reading: the alerts stay waiting for the next run.
			if cerr := s.CheckAlerts(ctx); cerr != nil {
				s.log.Error("fx alert check failed", "error", cerr.Error())
			}
			return nil
		}
		s.log.Warn("fx rate source failed", "error", err.Error())
		failures = append(failures, err)
	}
	return fmt.Errorf("every rate source failed: %w", errors.Join(failures...))
}

// store turns a snapshot into naira mid rates and writes them.
func (s *Service) store(ctx context.Context, snap Snapshot) error {
	now := s.now().UTC()
	mids, err := s.mids(ctx, snap, now)
	if err != nil {
		return err
	}
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := fxdb.New(tx)
		for _, pair := range Pairs {
			id, err := uuid.NewV7()
			if err != nil {
				return fmt.Errorf("rate id: %w", err)
			}
			if err := q.InsertRate(ctx, fxdb.InsertRateParams{
				ID: id, Pair: pair, MidE8: int64(mids[pair]), Source: snap.Source, AsOf: now,
			}); err != nil {
				return fmt.Errorf("insert %s rate: %w", pair, err)
			}
		}
		return nil
	})
}

// mids works out NGN per unit of each foreign currency from the dollar-based snapshot. A
// provider with no naira (Frankfurter) borrows the naira price of the dollar from the last
// good reading, so the euro and pound still follow the market while the naira leg is as
// old as that reading. The result is checked against the previous readings before it is
// stored.
func (s *Service) mids(ctx context.Context, snap Snapshot, now time.Time) (map[string]Rate, error) {
	ngn, ok := snap.PerUSD[money.NGN]
	if !ok {
		prev, err := s.q.LatestRate(ctx, "USD-NGN")
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && now.Sub(prev.AsOf) > anchorMaxAge) {
			return nil, errNoAnchor
		}
		if err != nil {
			return nil, fmt.Errorf("naira anchor: %w", err)
		}
		ngn = Rate(prev.MidE8)
	}
	mids := make(map[string]Rate, len(Pairs))
	for _, pair := range Pairs {
		per, ok := snap.PerUSD[money.Currency(pair[:3])]
		if !ok {
			return nil, fmt.Errorf("fx: snapshot from %s has no %s rate", snap.Source, pair[:3])
		}
		mid, err := cross(ngn, per)
		if err != nil {
			return nil, fmt.Errorf("fx: %s rate: %w", pair, err)
		}
		if err := s.checkJump(ctx, pair, mid, now); err != nil {
			return nil, err
		}
		mids[pair] = mid
	}
	return mids, nil
}

// checkJump refuses a rate that moved implausibly far from a recent reading. A provider
// that returns garbage once should not move every customer's price; if the market really
// moved that far, the guard lapses after jumpWindow and the new level is accepted.
func (s *Service) checkJump(ctx context.Context, pair string, mid Rate, now time.Time) error {
	prev, err := s.q.LatestRate(ctx, pair)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("previous %s rate: %w", pair, err)
	}
	if now.Sub(prev.AsOf) > jumpWindow {
		return nil
	}
	diff := int64(mid) - prev.MidE8
	if diff < 0 {
		diff = -diff
	}
	moved, err := money.MulDiv(diff, 10_000, prev.MidE8, money.Floor)
	if err != nil {
		return fmt.Errorf("compare %s rate: %w", pair, err)
	}
	if moved > maxJumpBPS {
		return fmt.Errorf("fx: %s moved %d bp in under %s (%s to %s): reading refused", pair, moved, jumpWindow, Rate(prev.MidE8), mid)
	}
	return nil
}

// Prune drops readings past the chart's reach, and quotes nobody used a day after they expired.
// It runs with the hourly housekeeping (jobs.Options.Housekeeping).
func (s *Service) Prune(ctx context.Context) error {
	now := s.now()
	var errs []error
	if _, err := s.q.PruneRates(ctx, now.Add(-retainRates)); err != nil {
		errs = append(errs, fmt.Errorf("prune rates: %w", err))
	}
	if _, err := s.q.PruneQuotes(ctx, now.Add(-retainQuotes)); err != nil {
		errs = append(errs, fmt.Errorf("prune quotes: %w", err))
	}
	if _, err := s.q.PruneAlerts(ctx, pgtype.Timestamptz{Time: now.Add(-alertKeep), Valid: true}); err != nil {
		errs = append(errs, fmt.Errorf("prune alerts: %w", err))
	}
	return errors.Join(errs...)
}

// IngestArgs is the hourly rates job.
type IngestArgs struct{}

// Kind implements river.JobArgs.
func (IngestArgs) Kind() string { return "fx_rates_ingest" }

type ingestWorker struct {
	river.WorkerDefaults[IngestArgs]
	s *Service
}

func (w *ingestWorker) Work(ctx context.Context, _ *river.Job[IngestArgs]) error {
	return w.s.Ingest(ctx)
}

// Register adds the FX workers (jobs.Options.Workers).
func (s *Service) Register(w *river.Workers) { river.AddWorker(w, &ingestWorker{s: s}) }

// PeriodicJobs are FX's clocks (jobs.Options.Periodic): rates are read hourly, and once at
// start so a fresh deploy never waits an hour for its first price. Three attempts is
// plenty: the next hour's run is the real retry.
func (s *Service) PeriodicJobs() []*river.PeriodicJob {
	return []*river.PeriodicJob{
		river.NewPeriodicJob(river.PeriodicInterval(time.Hour),
			func() (river.JobArgs, *river.InsertOpts) { return IngestArgs{}, &river.InsertOpts{MaxAttempts: 3} },
			&river.PeriodicJobOpts{RunOnStart: true}),
	}
}
