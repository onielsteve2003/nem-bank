package credit

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/credit/creditdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
)

// Loan events, for notifications (T30) to word.
const (
	TopicDisbursed = "credit.loan_disbursed"
	TopicRepayment = "credit.loan_repayment"
	TopicRepaid    = "credit.loan_repaid"
	TopicOverdue   = "credit.loan_overdue"
	TopicDefaulted = "credit.loan_defaulted"
)

// emit writes a loan event in the caller's transaction (notifications subscribe later).
func emit(ctx context.Context, tx pgx.Tx, topic string, loanID uuid.UUID, payload map[string]any) error {
	if _, err := jobs.Write(ctx, tx, jobs.Event{Topic: topic, AggregateType: "loan", AggregateID: loanID.String(), Payload: payload}); err != nil {
		return fmt.Errorf("write %s event: %w", topic, err)
	}
	return nil
}

// SweepArgs is the River job args for the credit clock.
type SweepArgs struct{}

// Kind implements river.JobArgs.
func (SweepArgs) Kind() string { return "credit_sweep" }

type sweepWorker struct {
	river.WorkerDefaults[SweepArgs]
	s *Service
}

func (w *sweepWorker) Work(ctx context.Context, _ *river.Job[SweepArgs]) error { return w.s.Sweep(ctx) }

// Register registers the credit sweep worker with River.
func (s *Service) Register(w *river.Workers) { river.AddWorker(w, &sweepWorker{s: s}) }

// PeriodicJobs returns the credit clock: every 5 minutes, so an instalment is collected soon
// after its day starts and soon after the customer tops up.
func (s *Service) PeriodicJobs() []*river.PeriodicJob {
	return []*river.PeriodicJob{
		river.NewPeriodicJob(river.PeriodicInterval(5*time.Minute),
			func() (river.JobArgs, *river.InsertOpts) { return SweepArgs{}, &river.InsertOpts{MaxAttempts: 3} },
			&river.PeriodicJobOpts{RunOnStart: true}),
	}
}

// Sweep looks at every loan still owing: it collects due instalments from loans on
// auto-repay (CRD-4), tells the customer once about an overdue instalment and marks a loan
// defaulted when an instalment has stayed unpaid for too long. One loan's failure never
// stops the others.
func (s *Service) Sweep(ctx context.Context) error {
	ids, err := s.q.ListOpenLoanIDs(ctx)
	if err != nil {
		return fmt.Errorf("list open loans: %w", err)
	}
	var errs []error
	for _, id := range ids {
		if err := s.sweepLoan(ctx, id); err != nil {
			s.log.Warn("loan sweep", slog.String("loan_id", id.String()), slog.Any("error", err))
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (s *Service) sweepLoan(ctx context.Context, id uuid.UUID) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := creditdb.New(tx)
		l, err := q.LockLoan(ctx, id)
		if err != nil {
			return fmt.Errorf("lock loan: %w", err)
		}
		if l.Status == "repaid" {
			return nil
		}
		today := lagosDay(s.now())
		items, err := q.ListInstallments(ctx, id)
		if err != nil {
			return fmt.Errorf("load schedule: %w", err)
		}
		if l.AutoRepay {
			var due int64
			for _, it := range items {
				if !it.DueDate.After(today) {
					due += it.AmountMinor - it.PaidMinor
				}
			}
			bal, err := ledger.GetBalances(ctx, tx, l.RepaymentAccountID)
			if err != nil {
				return err
			}
			// Take what is due, or what the account has if that is less: part of an
			// instalment is better than none.
			if take := min(due, bal.Available.Amount()); take > 0 {
				err := s.collect(ctx, tx, id, l.RepaymentAccountID, l.UserID, take, false, "Loan repayment (auto)")
				if errors.Is(err, ledger.ErrInsufficientFunds) {
					return nil // the balance moved since we looked: try again next sweep
				}
				if err != nil {
					return err
				}
				if items, err = q.ListInstallments(ctx, id); err != nil {
					return fmt.Errorf("reload schedule: %w", err)
				}
			}
		}
		return s.flagOverdue(ctx, tx, q, l, items, today)
	})
}

// flagOverdue tells the customer once about each instalment that has gone overdue, and
// defaults the loan when the oldest unpaid one is too old.
func (s *Service) flagOverdue(ctx context.Context, tx pgx.Tx, q *creditdb.Queries, l creditdb.Loan, items []creditdb.LoanInstallment, today time.Time) error {
	now := s.now().UTC()
	var oldest *creditdb.LoanInstallment
	for i, it := range items {
		if it.PaidMinor >= it.AmountMinor || !it.DueDate.Before(today) {
			continue
		}
		if oldest == nil {
			oldest = &items[i]
		}
		if it.OverdueNotifiedAt != nil {
			continue
		}
		if err := q.MarkInstallmentOverdueNotified(ctx, creditdb.MarkInstallmentOverdueNotifiedParams{LoanID: l.ID, Number: it.Number, At: &now}); err != nil {
			return fmt.Errorf("mark overdue: %w", err)
		}
		if err := emit(ctx, tx, TopicOverdue, l.ID, map[string]any{
			"user_id": l.UserID, "loan_id": l.ID, "installment": it.Number, "amount_minor": it.AmountMinor - it.PaidMinor, "due_date": it.DueDate.Format(time.DateOnly),
		}); err != nil {
			return err
		}
	}
	if oldest == nil || l.Status != "active" || today.Sub(oldest.DueDate) < defaultAfterDays*24*time.Hour {
		return nil
	}
	if err := q.SetLoanStatus(ctx, creditdb.SetLoanStatusParams{ID: l.ID, Status: "defaulted", DefaultedAt: &now}); err != nil {
		return fmt.Errorf("default loan: %w", err)
	}
	return emit(ctx, tx, TopicDefaulted, l.ID, map[string]any{"user_id": l.UserID, "loan_id": l.ID})
}
