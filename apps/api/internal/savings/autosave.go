package savings

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/savings/savingsdb"
)

// Auto-save events, for notifications (T30) to word.
const (
	TopicAutoSaved       = "savings.auto_saved"
	TopicAutoSaveSkipped = "savings.auto_save_skipped"
)

// nextAutoSave is one period after from, on the Lagos calendar. A month that is too short
// for the day lands on its last day, so "the 31st" never spills into the next month.
func nextAutoSave(from time.Time, frequency string) time.Time {
	t := from.In(lagos)
	switch frequency {
	case "weekly":
		return t.AddDate(0, 0, 7).UTC()
	case "monthly":
		first := time.Date(t.Year(), t.Month()+1, 1, t.Hour(), t.Minute(), t.Second(), t.Nanosecond(), lagos)
		last := first.AddDate(0, 1, -1).Day()
		return time.Date(first.Year(), first.Month(), min(t.Day(), last), t.Hour(), t.Minute(), t.Second(), t.Nanosecond(), lagos).UTC()
	default:
		return t.AddDate(0, 0, 1).UTC()
	}
}

// after is the first run time after now, stepping from due: runs missed while the server
// was down are skipped, never debited twice in a row.
func after(now, due time.Time, frequency string) time.Time {
	next := nextAutoSave(due, frequency)
	for !next.After(now) {
		next = nextAutoSave(next, frequency)
	}
	return next
}

// SweepAutoSaves runs every auto-save rule that is due (SAV-2) and returns how many moved
// money. One goal's failure never stops the others.
func (s *Service) SweepAutoSaves(ctx context.Context) (moved int, err error) {
	now := s.now().UTC()
	ids, err := s.q.ListDueAutoSaves(ctx, &now)
	if err != nil {
		return 0, fmt.Errorf("list due auto-saves: %w", err)
	}
	for _, id := range ids {
		ok, err := s.runAutoSave(ctx, id, now)
		if err != nil {
			s.log.Warn("auto-save", slog.String("goal_id", id.String()), slog.Any("error", err))
			continue
		}
		if ok {
			moved++
		}
	}
	return moved, nil
}

// runAutoSave makes one goal's due deposit. The goal row is locked and the rule re-read
// under the lock, so two sweeps (or a sweep and an edit) cannot deposit the same period
// twice: the loser sees a rule that is no longer due.
func (s *Service) runAutoSave(ctx context.Context, id uuid.UUID, now time.Time) (bool, error) {
	moved, err := s.autoSaveOnce(ctx, id, now, false)
	if errors.Is(err, ledger.ErrInsufficientFunds) {
		// The deposit rolled back whole. Record the skipped period in its own transaction
		// so it is not retried every sweep until the account is topped up.
		_, err = s.autoSaveOnce(ctx, id, now, true)
		return false, err
	}
	return moved, err
}

func (s *Service) autoSaveOnce(ctx context.Context, id uuid.UUID, now time.Time, skip bool) (bool, error) {
	var moved bool
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := savingsdb.New(tx)
		g, err := q.LockGoal(ctx, id)
		if err != nil {
			return fmt.Errorf("lock goal: %w", err)
		}
		if g.Status != "active" || g.AutoSaveNextAt == nil || g.AutoSaveNextAt.After(now) {
			return nil
		}
		due, freq := *g.AutoSaveNextAt, deref(g.AutoSaveFrequency)
		next := after(now, due, freq)
		amount := naira(*g.AutoSaveAmountMinor)
		event := map[string]any{"user_id": g.UserID, "goal_id": g.ID, "goal_name": g.Name, "amount_minor": amount.Amount(), "currency": "NGN"}

		bal, err := ledger.GetBalances(ctx, tx, g.AccountID)
		if err != nil {
			return fmt.Errorf("goal balance: %w", err)
		}
		// Done saving: the rule stays, but it has nothing left to do until the target moves.
		if bal.Ledger.Amount() >= g.TargetMinor {
			return q.SetAutoSaveNext(ctx, savingsdb.SetAutoSaveNextParams{ID: id, Next: &next})
		}
		if skip {
			event["reason"] = "insufficient_funds"
			if err := emit(ctx, tx, TopicAutoSaveSkipped, g.ID, event); err != nil {
				return err
			}
			return q.SetAutoSaveNext(ctx, savingsdb.SetAutoSaveNextParams{ID: id, Next: &next})
		}
		lineID, err := uuid.NewV7()
		if err != nil {
			return fmt.Errorf("movement id: %w", err)
		}
		ref := reference("SAV", lineID)
		posted, err := ledger.Post(ctx, tx, ledger.Entry{
			Kind: "savings", Reference: ref, IdempotencyKey: fmt.Sprintf("autosave:%s:%d", g.ID, due.Unix()),
			Metadata: map[string]any{"goal_id": g.ID.String(), "auto_save": true},
			Legs:     []ledger.Leg{ledger.Debit(*g.AutoSaveSourceID, amount), ledger.Credit(g.AccountID, amount)},
		})
		if err != nil {
			return err
		}
		if err := s.record(ctx, tx, accounts.Line{
			ID: lineID, UserID: g.UserID, AccountID: *g.AutoSaveSourceID, Type: "savings", Direction: "debit", Status: "completed",
			Amount: amount, Entry: &posted, Narration: "Auto-save to " + g.Name, Reference: ref, Category: "savings", At: now,
		}); err != nil {
			return err
		}
		if err := emit(ctx, tx, TopicAutoSaved, g.ID, event); err != nil {
			return err
		}
		moved = true
		return q.SetAutoSaveNext(ctx, savingsdb.SetAutoSaveNextParams{ID: id, Next: &next})
	})
	return moved, err
}

// SweepArgs is the savings clock's job: auto-saves now, interest accrual and lock
// maturity (T28.3) join it.
type SweepArgs struct{}

// Kind implements river.JobArgs.
func (SweepArgs) Kind() string { return "savings_sweep" }

type sweepWorker struct {
	river.WorkerDefaults[SweepArgs]
	s *Service
}

func (w *sweepWorker) Work(ctx context.Context, _ *river.Job[SweepArgs]) error {
	_, err := w.s.SweepAutoSaves(ctx)
	return err
}

// Register adds the savings workers (jobs.Options.Workers).
func (s *Service) Register(w *river.Workers) { river.AddWorker(w, &sweepWorker{s: s}) }

// PeriodicJobs are the savings clocks (jobs.Options.Periodic).
func (s *Service) PeriodicJobs() []*river.PeriodicJob {
	return []*river.PeriodicJob{
		river.NewPeriodicJob(river.PeriodicInterval(5*time.Minute),
			func() (river.JobArgs, *river.InsertOpts) { return SweepArgs{}, &river.InsertOpts{MaxAttempts: 3} },
			&river.PeriodicJobOpts{RunOnStart: true}),
	}
}

var _ = money.NGN
