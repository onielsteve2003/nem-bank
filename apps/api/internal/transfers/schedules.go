package transfers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/limits"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/pagination"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers/transfersdb"
)

// Scheduled and recurring transfers (TRF-9). A schedule stores where the money goes; every
// run is a normal transfer (limits, fees, cooling-off), committed in the same database
// transaction that advances the schedule, so a run happens once or not at all.

var (
	// ErrScheduleNotFound is the 404 for a schedule the caller does not have.
	ErrScheduleNotFound = problem.NotFound("Scheduled transfer")
	errScheduleEnded    = problem.New(http.StatusConflict, "invalid_state", "This schedule has ended")
	errStartInPast      = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "Pick a start time in the future")
	errEndsBeforeStart  = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "The end date is before the first run")
)

// RunDueBatch is how many due schedules one runner pass takes.
const RunDueBatch = 50

// NewSchedule is a schedule request that passed contract validation.
type NewSchedule struct {
	SourceAccountID uuid.UUID
	Destination     api.TransferDestination
	Amount          money.Money
	Narration       string
	Frequency       string
	StartAt         time.Time
	EndsOn          *time.Time
}

// CreateSchedule sets up a one-off or recurring transfer. The payee is resolved now and
// stored as an account, so the runs do not depend on the beneficiary list.
func (s *Service) CreateSchedule(ctx context.Context, n NewSchedule) (transfersdb.ScheduledTransfer, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return transfersdb.ScheduledTransfer{}, problem.Unauthorized()
	}
	src, err := s.accounts.Owned(ctx, p.UserID, n.SourceAccountID)
	if err != nil {
		return transfersdb.ScheduledTransfer{}, err
	}
	if src.Currency != string(money.NGN) || n.Amount.Currency() != money.NGN {
		return transfersdb.ScheduledTransfer{}, errNotNaira
	}
	if !n.Amount.IsPositive() {
		return transfersdb.ScheduledTransfer{}, problem.Validation(problem.Field("/amount", "positive", "Enter an amount above zero."))
	}
	if n.StartAt.Before(s.now().Truncate(time.Minute)) {
		return transfersdb.ScheduledTransfer{}, errStartInPast
	}
	if n.EndsOn != nil && n.EndsOn.Before(limits.Day(n.StartAt)) {
		return transfersdb.ScheduledTransfer{}, errEndsBeforeStart
	}
	dest, err := s.resolve(ctx, p.UserID, n.Destination)
	if err != nil {
		return transfersdb.ScheduledTransfer{}, err
	}
	if dest.internal() && dest.nem.UserID == p.UserID {
		return transfersdb.ScheduledTransfer{}, errOwnAccount
	}
	stored, err := dest.destination()
	if err != nil {
		return transfersdb.ScheduledTransfer{}, err
	}
	destJSON, err := json.Marshal(stored)
	if err != nil {
		return transfersdb.ScheduledTransfer{}, fmt.Errorf("destination: %w", err)
	}
	party, err := json.Marshal(dest.party)
	if err != nil {
		return transfersdb.ScheduledTransfer{}, fmt.Errorf("recipient: %w", err)
	}
	narration := strings.TrimSpace(n.Narration)
	if narration == "" {
		narration = "Scheduled transfer to " + dest.party.Name
	}
	id, err := uuid.NewV7()
	if err != nil {
		return transfersdb.ScheduledTransfer{}, fmt.Errorf("schedule id: %w", err)
	}
	start := n.StartAt.UTC()
	sch, err := s.q.InsertSchedule(ctx, transfersdb.InsertScheduleParams{
		ID: id, UserID: p.UserID, SourceAccountID: src.AccountID, Destination: destJSON, Recipient: party,
		Currency: string(money.NGN), AmountMinor: n.Amount.Amount(), Narration: narration, Frequency: n.Frequency,
		NextRunAt: &start, EndsOn: n.EndsOn,
	})
	if err != nil {
		return sch, fmt.Errorf("insert schedule: %w", err)
	}
	return sch, nil
}

// GetSchedule returns one of the caller's schedules.
func (s *Service) GetSchedule(ctx context.Context, id uuid.UUID) (transfersdb.ScheduledTransfer, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return transfersdb.ScheduledTransfer{}, problem.Unauthorized()
	}
	sch, err := s.q.GetSchedule(ctx, transfersdb.GetScheduleParams{ID: id, UserID: p.UserID})
	if errors.Is(err, pgx.ErrNoRows) {
		return sch, ErrScheduleNotFound
	}
	if err != nil {
		return sch, fmt.Errorf("load schedule: %w", err)
	}
	return sch, nil
}

// ListSchedules pages the caller's schedules, next run first.
func (s *Service) ListSchedules(ctx context.Context, cursor *string, limit *int) ([]transfersdb.ScheduledTransfer, api.PageInfo, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return nil, api.PageInfo{}, problem.Unauthorized()
	}
	off, err := decodeOffset(cursor)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	n := pagination.Limit(limit)
	rows, err := s.q.ListSchedules(ctx, transfersdb.ListSchedulesParams{UserID: p.UserID, Off: off, Lim: int32(n + 1)}) //nolint:gosec // n ≤ pagination.MaxLimit
	if err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("list schedules: %w", err)
	}
	rows, page := offsetPage(rows, n, off)
	return rows, page, nil
}

// ScheduleChange pauses, resumes or edits a schedule; nil fields stay as they are.
type ScheduleChange struct {
	Status    *string
	Amount    *money.Money
	NextRunAt *time.Time
}

// UpdateSchedule applies a change. Runs missed while paused are skipped on resume, not
// sent in a burst.
func (s *Service) UpdateSchedule(ctx context.Context, id uuid.UUID, c ScheduleChange) (transfersdb.ScheduledTransfer, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return transfersdb.ScheduledTransfer{}, problem.Unauthorized()
	}
	var out transfersdb.ScheduledTransfer
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		sch, err := s.lockSchedule(ctx, q, p.UserID, id)
		if err != nil {
			return err
		}
		if sch.Status == "cancelled" || sch.Status == "completed" {
			return errScheduleEnded
		}
		if c.Status != nil {
			sch.Status = *c.Status
		}
		if c.Amount != nil {
			if c.Amount.Currency() != money.NGN {
				return errNotNaira
			}
			if !c.Amount.IsPositive() {
				return problem.Validation(problem.Field("/amount", "positive", "Enter an amount above zero."))
			}
			sch.AmountMinor = c.Amount.Amount()
		}
		if c.NextRunAt != nil {
			at := c.NextRunAt.UTC()
			sch.NextRunAt = &at
		}
		if sch.Status == "active" {
			for sch.NextRunAt != nil && !sch.NextRunAt.After(s.now()) {
				s.advance(&sch, *sch.NextRunAt)
			}
		}
		out, err = q.SaveSchedule(ctx, saveParams(sch))
		return err
	})
	return out, err
}

// CancelSchedule stops all future runs.
func (s *Service) CancelSchedule(ctx context.Context, id uuid.UUID) error {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return problem.Unauthorized()
	}
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		sch, err := s.lockSchedule(ctx, q, p.UserID, id)
		if err != nil {
			return err
		}
		sch.Status, sch.NextRunAt = "cancelled", nil
		_, err = q.SaveSchedule(ctx, saveParams(sch))
		return err
	})
}

func (s *Service) lockSchedule(ctx context.Context, q *transfersdb.Queries, userID, id uuid.UUID) (transfersdb.ScheduledTransfer, error) {
	sch, err := q.LockSchedule(ctx, transfersdb.LockScheduleParams{ID: id, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return sch, ErrScheduleNotFound
	}
	if err != nil {
		return sch, fmt.Errorf("lock schedule: %w", err)
	}
	return sch, nil
}

func saveParams(sch transfersdb.ScheduledTransfer) transfersdb.SaveScheduleParams {
	return transfersdb.SaveScheduleParams{
		ID: sch.ID, Status: sch.Status, AmountMinor: sch.AmountMinor, NextRunAt: sch.NextRunAt,
		RunCount: sch.RunCount, LastRun: sch.LastRun,
	}
}

// advance moves the schedule past the run at "at": to the next one, or to completed when
// it was a one-off or the next run falls after ends_on (a Lagos date).
func (s *Service) advance(sch *transfersdb.ScheduledTransfer, at time.Time) {
	var next time.Time
	switch sch.Frequency {
	case "daily":
		next = at.AddDate(0, 0, 1)
	case "weekly":
		next = at.AddDate(0, 0, 7)
	case "monthly":
		next = at.AddDate(0, 1, 0)
	default: // once
		sch.Status, sch.NextRunAt = "completed", nil
		return
	}
	if sch.EndsOn != nil && limits.Day(next).After(*sch.EndsOn) {
		sch.Status, sch.NextRunAt = "completed", nil
		return
	}
	sch.NextRunAt = &next
}

// RunArgs is the runner's periodic pass over due schedules.
type RunArgs struct{}

// Kind implements river.JobArgs.
func (RunArgs) Kind() string { return "scheduled_transfers_run" }

type runWorker struct {
	river.WorkerDefaults[RunArgs]
	s *Service
}

func (w *runWorker) Work(ctx context.Context, _ *river.Job[RunArgs]) error { return w.s.RunDue(ctx) }

// PeriodicJobs are the transfers domain's clocks (jobs.Options.Periodic): due schedules
// are looked for every minute.
func (s *Service) PeriodicJobs() []*river.PeriodicJob {
	return []*river.PeriodicJob{river.NewPeriodicJob(river.PeriodicInterval(time.Minute),
		func() (river.JobArgs, *river.InsertOpts) { return RunArgs{}, nil }, &river.PeriodicJobOpts{RunOnStart: true})}
}

// RunDue runs the schedules that are due. A schedule whose run fails for a database or
// partner fault is left due and retried on the next pass; one refused by the bank's rules
// (limits, funds) records a failed run and moves on.
func (s *Service) RunDue(ctx context.Context) error {
	due, err := s.q.ListDueSchedules(ctx, transfersdb.ListDueSchedulesParams{Now: ptr(s.now()), Lim: RunDueBatch})
	if err != nil {
		return fmt.Errorf("list due schedules: %w", err)
	}
	var errs []error
	for _, d := range due {
		if err := s.runSchedule(ctx, d.ID, d.UserID); err != nil {
			s.log.ErrorContext(ctx, "scheduled transfer run failed", slog.String("schedule_id", d.ID.String()), slog.Any("error", err))
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (s *Service) runSchedule(ctx context.Context, id, userID uuid.UUID) error {
	sch, err := s.q.GetSchedule(ctx, transfersdb.GetScheduleParams{ID: id, UserID: userID})
	if err != nil {
		return fmt.Errorf("load schedule: %w", err)
	}
	var dest api.TransferDestination
	if err := json.Unmarshal(sch.Destination, &dest); err != nil {
		return fmt.Errorf("schedule destination: %w", err)
	}
	// Planned outside the transaction (name enquiry is a network call). The run itself has
	// no device: the customer signed the schedule when they made it.
	pl, planErr := s.prepare(ctx, userID, Request{
		SourceAccountID: sch.SourceAccountID, Destination: dest, Amount: money.New(sch.AmountMinor, money.NGN), Narration: sch.Narration,
	}, identity.CoolOff{})
	if planErr != nil && !isRefusal(planErr) {
		return planErr
	}
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		sch, err := q.ClaimDueSchedule(ctx, transfersdb.ClaimDueScheduleParams{ID: id, Now: ptr(s.now())})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // another runner has it, or it was paused or edited meanwhile
		}
		if err != nil {
			return fmt.Errorf("claim schedule: %w", err)
		}
		at := *sch.NextRunAt
		run := api.ScheduledRun{At: at.UTC(), Status: api.TransferStatus(Failed)}
		runErr := planErr
		if runErr == nil {
			sp, err := tx.Begin(ctx)
			if err != nil {
				return fmt.Errorf("savepoint: %w", err)
			}
			tid, err := s.commit(ctx, sp, pl)
			if err != nil {
				if rerr := sp.Rollback(ctx); rerr != nil {
					return fmt.Errorf("rollback to savepoint: %w", rerr)
				}
				if !isRefusal(err) {
					return err
				}
				runErr = err
			} else {
				if err := sp.Commit(ctx); err != nil {
					return fmt.Errorf("release savepoint: %w", err)
				}
				t, err := q.GetTransferByID(ctx, tid)
				if err != nil {
					return fmt.Errorf("load run transfer: %w", err)
				}
				run.Status, run.TransferId = api.TransferStatus(t.Status), &tid
			}
		}
		if runErr != nil {
			var p *problem.Error
			errors.As(runErr, &p)
			// For the notifications subscriber: "Scheduled transfer skipped" with the reason.
			if _, err := jobs.Write(ctx, tx, jobs.Event{
				Topic: "schedule.run_skipped", AggregateType: "scheduled_transfer", AggregateID: id.String(),
				Payload: map[string]any{"schedule_id": id, "user_id": userID, "code": p.Code, "reason": p.Title, "detail": p.Detail},
			}); err != nil {
				return err
			}
		}
		lastRun, err := json.Marshal(run)
		if err != nil {
			return fmt.Errorf("last run: %w", err)
		}
		sch.RunCount++
		sch.LastRun = lastRun
		s.advance(&sch, at)
		_, err = q.SaveSchedule(ctx, saveParams(sch))
		return err
	})
}

// isRefusal reports whether err is the bank saying no (a problem the customer would see),
// as opposed to a fault worth retrying.
func isRefusal(err error) bool {
	var p *problem.Error
	return errors.As(err, &p) && p.Status < http.StatusInternalServerError
}

// ScheduleJSON is the contract's ScheduledTransfer.
func ScheduleJSON(sch transfersdb.ScheduledTransfer) (api.ScheduledTransfer, error) {
	var party api.TransferParty
	if err := json.Unmarshal(sch.Recipient, &party); err != nil {
		return api.ScheduledTransfer{}, fmt.Errorf("recipient: %w", err)
	}
	out := api.ScheduledTransfer{
		Id: sch.ID, SourceAccountId: sch.SourceAccountID, Recipient: party,
		Amount: accounts.Money(money.New(sch.AmountMinor, money.Currency(sch.Currency))), Narration: sch.Narration,
		Frequency: api.ScheduleFrequency(sch.Frequency), Status: api.ScheduledTransferStatus(sch.Status),
		NextRunAt: utc(sch.NextRunAt), RunCount: int(sch.RunCount), CreatedAt: sch.CreatedAt.UTC(),
	}
	if sch.EndsOn != nil {
		d := api.Date{Time: *sch.EndsOn}
		out.EndsOn = &d
	}
	if sch.LastRun != nil {
		var r api.ScheduledRun
		if err := json.Unmarshal(sch.LastRun, &r); err != nil {
			return out, fmt.Errorf("last run: %w", err)
		}
		out.LastRun = &r
	}
	return out, nil
}
