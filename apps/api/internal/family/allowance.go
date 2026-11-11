package family

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/family/familydb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers"
)

var noCoolOff = identity.CoolOff{}

// runHour is when an allowance is paid: 08:00 Lagos time.
const runHour = 8

// nextRun is the first allowance time strictly after t. Weekly counts days Monday = 1 to Sunday
// = 7, monthly counts the day of the month (1 to 28, so every month has one).
func nextRun(t time.Time, frequency string, day int) time.Time {
	t = t.In(lagos)
	if frequency == "weekly" {
		iso := int(t.Weekday())
		if iso == 0 {
			iso = 7
		}
		c := time.Date(t.Year(), t.Month(), t.Day()+(day-iso+7)%7, runHour, 0, 0, 0, lagos)
		if !c.After(t) {
			c = c.AddDate(0, 0, 7)
		}
		return c
	}
	c := time.Date(t.Year(), t.Month(), day, runHour, 0, 0, 0, lagos)
	if !c.After(t) {
		c = time.Date(t.Year(), t.Month()+1, day, runHour, 0, 0, 0, lagos)
	}
	return c
}

// SetAllowance sets a recurring transfer from the parent's naira account to the dependant
// (FAM-2). The first payment is the next 08:00 Lagos time on the chosen day.
func (s *Service) SetAllowance(ctx context.Context, id uuid.UUID, a api.Allowance) (api.Dependant, error) {
	p, err := principal(ctx)
	if err != nil {
		return api.Dependant{}, err
	}
	amount, err := ngn(a.Amount, "/amount")
	if err != nil {
		return api.Dependant{}, err
	}
	freq := string(a.Frequency)
	day := 1
	if freq == "weekly" {
		day = 5 // Friday, the usual pocket-money day
	}
	if a.Day != nil {
		day = *a.Day
	}
	if day < 1 || (freq == "weekly" && day > 7) || day > 28 {
		msg := "Pick a day from 1 to 28."
		if freq == "weekly" {
			msg = "Pick a weekday, 1 (Monday) to 7 (Sunday)."
		}
		return api.Dependant{}, problem.Validation(problem.Field("/day", "invalid", msg))
	}
	src, err := s.accounts.Owned(ctx, p.UserID, a.SourceAccountId)
	if err != nil {
		return api.Dependant{}, err
	}
	if src.Currency != string(money.NGN) {
		return api.Dependant{}, problem.Validation(problem.Field("/source_account_id", "currency", "Allowances are paid from a naira account."))
	}
	next := nextRun(s.now(), freq, day).UTC()
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		if _, err := q.GetDependantForUpdate(ctx, familydb.GetDependantForUpdateParams{ID: id, GuardianID: p.UserID}); errors.Is(err, pgx.ErrNoRows) {
			return errDependantNotFound
		} else if err != nil {
			return fmt.Errorf("lock dependant: %w", err)
		}
		return q.SetAllowance(ctx, familydb.SetAllowanceParams{
			ID: id, AmountMinor: &amount, Frequency: &freq, Day: pgtype.Int2{Int16: int16(day), Valid: true}, //nolint:gosec // 1 to 28
			SourceAccountID: &a.SourceAccountId, NextRunAt: &next,
		})
	})
	if err != nil {
		return api.Dependant{}, err
	}
	return s.dependant(ctx, p.UserID, id)
}

// StopAllowance ends the allowance. Stopping one that is not set is not an error.
func (s *Service) StopAllowance(ctx context.Context, id uuid.UUID) error {
	p, err := principal(ctx)
	if err != nil {
		return err
	}
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		if _, err := q.GetDependantForUpdate(ctx, familydb.GetDependantForUpdateParams{ID: id, GuardianID: p.UserID}); errors.Is(err, pgx.ErrNoRows) {
			return errDependantNotFound
		} else if err != nil {
			return fmt.Errorf("lock dependant: %w", err)
		}
		return q.ClearAllowance(ctx, id)
	})
}

// RunArgs is the River job args for the family clock.
type RunArgs struct{}

// Kind implements river.JobArgs.
func (RunArgs) Kind() string { return "family_run" }

type runWorker struct {
	river.WorkerDefaults[RunArgs]
	s *Service
}

func (w *runWorker) Work(ctx context.Context, _ *river.Job[RunArgs]) error {
	return errors.Join(w.s.RunDue(ctx), w.s.ExpireDue(ctx))
}

// Register registers the family worker with River.
func (s *Service) Register(w *river.Workers) { river.AddWorker(w, &runWorker{s: s}) }

// PeriodicJobs returns the family clock: every minute it pays due allowances and lapses
// requests nobody answered.
func (s *Service) PeriodicJobs() []*river.PeriodicJob {
	return []*river.PeriodicJob{
		river.NewPeriodicJob(river.PeriodicInterval(time.Minute),
			func() (river.JobArgs, *river.InsertOpts) { return RunArgs{}, &river.InsertOpts{MaxAttempts: 3} },
			&river.PeriodicJobOpts{RunOnStart: true}),
	}
}

// RunDue pays the allowances that are due. A run the bank refuses (not enough money, a limit)
// is recorded and the parent told, and the allowance moves on to its next date; a database or
// partner fault leaves the run due, to be tried on the next pass.
func (s *Service) RunDue(ctx context.Context) error {
	due, err := s.q.ListDueAllowances(ctx, familydb.ListDueAllowancesParams{Now: ptr(s.now().UTC()), Lim: runBatch})
	if err != nil {
		return fmt.Errorf("list due allowances: %w", err)
	}
	var errs []error
	for _, d := range due {
		if err := s.runAllowance(ctx, d.ID); err != nil {
			s.log.ErrorContext(ctx, "allowance run failed", "dependant_id", d.ID.String(), "error", err)
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func ptr[T any](v T) *T { return &v }

// errSkip means another runner took the run, or the allowance changed since it was read.
var errSkip = errors.New("family: allowance run taken")

func (s *Service) runAllowance(ctx context.Context, id uuid.UUID) error {
	d, err := s.q.GetDependantByID(ctx, id)
	if err != nil {
		return fmt.Errorf("load dependant: %w", err)
	}
	if d.AllowanceNextRunAt == nil || d.AllowanceAmountMinor == nil || d.AllowanceFrequency == nil || d.AllowanceSourceAccountID == nil {
		return nil
	}
	at, amount := *d.AllowanceNextRunAt, *d.AllowanceAmountMinor
	// A pause or an outage does not pile up payments: the next one is the next date after now.
	next := nextRun(s.now(), *d.AllowanceFrequency, int(d.AllowanceDay.Int16)).UTC()
	claim := func(ctx context.Context, tx pgx.Tx) error {
		if _, err := s.q.WithTx(tx).ClaimAllowanceRun(ctx, familydb.ClaimAllowanceRunParams{ID: id, NextRunAt: &next, Expected: &at}); errors.Is(err, pgx.ErrNoRows) {
			return errSkip
		} else if err != nil {
			return fmt.Errorf("claim allowance run: %w", err)
		}
		return nil
	}
	name, err := s.q.GetUserName(ctx, d.UserID)
	if err != nil {
		return fmt.Errorf("load dependant name: %w", err)
	}
	event := func(ctx context.Context, tx pgx.Tx, topic, reason string) error {
		return emit(ctx, tx, topic, "dependant", id, map[string]any{
			"guardian_id": d.GuardianID, "user_id": d.UserID, "dependant_name": name.FirstName,
			"amount_minor": amount, "currency": string(money.NGN), "reason": reason,
		})
	}
	fail := func(reason string) error {
		err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
			if err := claim(ctx, tx); err != nil {
				return err
			}
			return event(ctx, tx, TopicAllowanceFailed, reason)
		})
		if errors.Is(err, errSkip) {
			return nil
		}
		return err
	}
	if d.Paused {
		return fail("This account is paused.")
	}
	acct, err := s.q.GetNairaAccount(ctx, d.UserID)
	if err != nil {
		return fmt.Errorf("load dependant account: %w", err)
	}
	var dest api.TransferDestination
	if err := dest.FromNemDestination(api.NemDestination{Kind: api.NemDestinationKindNem, AccountNumber: acct.AccountNumber}); err != nil {
		return fmt.Errorf("allowance destination: %w", err)
	}
	cat := "family"
	_, err = s.sender.SendAs(ctx, d.GuardianID, transfers.Request{
		SourceAccountID: *d.AllowanceSourceAccountID, Destination: dest, Amount: money.New(amount, money.NGN),
		Narration: "Allowance for " + name.FirstName, Category: &cat,
	}, transfers.Hooks{
		Before: claim,
		After: func(ctx context.Context, tx pgx.Tx, _ uuid.UUID) error {
			return event(ctx, tx, TopicAllowanceSent, "")
		},
	})
	switch {
	case err == nil, errors.Is(err, errSkip):
		return nil
	case isRefusal(err):
		var p *problem.Error
		errors.As(err, &p)
		reason := p.Title
		if p.Detail != "" {
			reason += ". " + p.Detail
		}
		return fail(reason)
	default:
		return err
	}
}

// isRefusal reports whether err is the bank saying no (a problem the parent would read), as
// opposed to a fault worth retrying.
func isRefusal(err error) bool {
	var p *problem.Error
	return errors.As(err, &p) && p.Status < http.StatusInternalServerError
}
