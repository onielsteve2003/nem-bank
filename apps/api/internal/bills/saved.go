package bills

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// Saved billers and scheduled bills (BILL-3). A saved biller is a shortcut to a meter,
// smartcard or phone number. A schedule pays a bill once or on a repeat; every run is a normal
// payment (limits, fees, the biller), claimed before it is paid so a run happens at most once.

const (
	maxSavedBillers = 30
	maxSchedules    = 20
	// scheduleBatch is how many due schedules one runner pass takes.
	scheduleBatch = 50
)

var (
	// ErrSavedBillerNotFound is the 404 for a saved biller the caller does not have.
	ErrSavedBillerNotFound = problem.NotFound("Saved biller")
	// ErrScheduleNotFound is the 404 for a schedule the caller does not have.
	ErrScheduleNotFound = problem.NotFound("Scheduled bill")
	errTooManySaved     = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "You can save up to 30 billers").
				WithDetail("Remove one you no longer use first.")
	errTooManySchedules = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "You can have up to 20 scheduled bills").
				WithDetail("Cancel one you no longer need first.")
	errStartInPast = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "Pick a start time in the future")
)

// SavedBiller is a biller the customer saved under a nickname.
type SavedBiller struct {
	ID           uuid.UUID
	BillerID     string
	BillerName   string
	Category     string
	CustomerID   string
	CustomerName *string
	Nickname     string
	CreatedAt    time.Time
}

func caller(ctx context.Context) (identity.Principal, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return identity.Principal{}, problem.Unauthorized()
	}
	return p, nil
}

// SaveBiller saves a biller for the caller. Saving the same meter or number again changes its
// nickname and returns it, so a repeated tap never makes a second copy.
func (s *Service) SaveBiller(ctx context.Context, billerID, customerID, nickname string) (SavedBiller, error) {
	p, err := caller(ctx)
	if err != nil {
		return SavedBiller{}, err
	}
	customerID, nickname = strings.TrimSpace(customerID), strings.TrimSpace(nickname)
	switch {
	case customerID == "" || len(customerID) > 40:
		return SavedBiller{}, problem.Validation(problem.Field("/customer_id", "invalid", "Enter the meter, smartcard or phone number"))
	case nickname == "" || len([]rune(nickname)) > 30:
		return SavedBiller{}, problem.Validation(problem.Field("/nickname", "invalid", "Use a nickname of 1 to 30 characters"))
	}
	b, err := s.info(ctx, billerID)
	if err != nil {
		return SavedBiller{}, err
	}
	// The name on a meter or smartcard, when the biller can say it; a failed lookup only means no name.
	var name *string
	if b.RequiresValidation {
		if c, err := s.biller.Validate(ctx, b.ID, customerID); err == nil && c.Name != "" {
			name = &c.Name
		}
	}
	id, err := uuid.NewV7()
	if err != nil {
		return SavedBiller{}, fmt.Errorf("saved biller id: %w", err)
	}
	var out SavedBiller
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		// One lock per customer, so the cap holds when two saves race.
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('saved_billers:' || $1::text, 0))`, p.UserID); err != nil {
			return fmt.Errorf("lock saved billers: %w", err)
		}
		var n int
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT COUNT(*)::int, COALESCE(bool_or(biller_id = $2 AND customer_id = $3), false) FROM saved_billers WHERE user_id = $1`,
			p.UserID, b.ID, customerID).Scan(&n, &exists); err != nil {
			return fmt.Errorf("count saved billers: %w", err)
		}
		if !exists && n >= maxSavedBillers {
			return errTooManySaved
		}
		return tx.QueryRow(ctx, `
INSERT INTO saved_billers (id, user_id, biller_id, biller_name, category, customer_id, customer_name, nickname)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (user_id, biller_id, customer_id)
DO UPDATE SET nickname = EXCLUDED.nickname, customer_name = COALESCE(EXCLUDED.customer_name, saved_billers.customer_name)
RETURNING id, biller_id, biller_name, category, customer_id, customer_name, nickname, created_at`,
			id, p.UserID, b.ID, b.Name, b.Category, customerID, name, nickname).
			Scan(&out.ID, &out.BillerID, &out.BillerName, &out.Category, &out.CustomerID, &out.CustomerName, &out.Nickname, &out.CreatedAt)
	})
	if err != nil {
		var pe *problem.Error
		if errors.As(err, &pe) {
			return SavedBiller{}, pe
		}
		return SavedBiller{}, fmt.Errorf("save biller: %w", err)
	}
	return out, nil
}

// SavedBillers lists the caller's saved billers, newest first.
func (s *Service) SavedBillers(ctx context.Context) ([]SavedBiller, error) {
	p, err := caller(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
SELECT id, biller_id, biller_name, category, customer_id, customer_name, nickname, created_at
FROM saved_billers WHERE user_id = $1 ORDER BY created_at DESC, id DESC`, p.UserID)
	if err != nil {
		return nil, fmt.Errorf("list saved billers: %w", err)
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (SavedBiller, error) {
		var b SavedBiller
		return b, r.Scan(&b.ID, &b.BillerID, &b.BillerName, &b.Category, &b.CustomerID, &b.CustomerName, &b.Nickname, &b.CreatedAt)
	})
	if err != nil {
		return nil, fmt.Errorf("read saved billers: %w", err)
	}
	return out, nil
}

// DeleteSavedBiller removes one of the caller's saved billers.
func (s *Service) DeleteSavedBiller(ctx context.Context, id uuid.UUID) error {
	p, err := caller(ctx)
	if err != nil {
		return err
	}
	tag, err := s.pool.Exec(ctx, `DELETE FROM saved_billers WHERE id = $1 AND user_id = $2`, id, p.UserID)
	if err != nil {
		return fmt.Errorf("delete saved biller: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrSavedBillerNotFound
	}
	return nil
}

// Schedule is a bill paid once or on a repeat.
type Schedule struct {
	ID         uuid.UUID
	BillerName string
	CustomerID string
	Amount     money.Money
	Frequency  string
	Status     string
	NextRunAt  *time.Time
	CreatedAt  time.Time
}

// NewSchedule is a schedule to create.
type NewSchedule struct {
	Pay       PayRequest
	Frequency string
	StartAt   time.Time
}

const scheduleCols = `id, biller_name, customer_id, amount_minor, frequency, status, next_run_at, created_at`

func scanSchedule(r pgx.Row) (Schedule, error) {
	var sc Schedule
	var minor int64
	if err := r.Scan(&sc.ID, &sc.BillerName, &sc.CustomerID, &minor, &sc.Frequency, &sc.Status, &sc.NextRunAt, &sc.CreatedAt); err != nil {
		return Schedule{}, err
	}
	sc.Amount = money.New(minor, money.NGN)
	return sc, nil
}

// CreateSchedule sets up a scheduled bill. The payment is checked as if it were paid now, so a
// wrong meter, plan or amount is refused when it is set up, not on the first run.
func (s *Service) CreateSchedule(ctx context.Context, n NewSchedule) (Schedule, error) {
	p, err := caller(ctx)
	if err != nil {
		return Schedule{}, err
	}
	if n.StartAt.Before(s.now().Truncate(time.Minute)) {
		return Schedule{}, errStartInPast
	}
	b, err := s.info(ctx, n.Pay.BillerID)
	if err != nil {
		return Schedule{}, err
	}
	customerID, _, err := s.check(ctx, b, n.Pay)
	if err != nil {
		return Schedule{}, err
	}
	src, err := s.accounts.Owned(ctx, p.UserID, n.Pay.Source)
	if err != nil {
		return Schedule{}, err
	}
	if src.Currency != string(money.NGN) {
		return Schedule{}, errNaira
	}
	id, err := uuid.NewV7()
	if err != nil {
		return Schedule{}, fmt.Errorf("schedule id: %w", err)
	}
	var product *string
	if n.Pay.ProductID != "" {
		product = &n.Pay.ProductID
	}
	var sc Schedule
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('bill_schedules:' || $1::text, 0))`, p.UserID); err != nil {
			return fmt.Errorf("lock schedules: %w", err)
		}
		var live int
		if err := tx.QueryRow(ctx, `SELECT COUNT(*)::int FROM bill_schedules WHERE user_id = $1 AND status = 'active'`, p.UserID).Scan(&live); err != nil {
			return fmt.Errorf("count schedules: %w", err)
		}
		if live >= maxSchedules {
			return errTooManySchedules
		}
		var err error
		sc, err = scanSchedule(tx.QueryRow(ctx, `
INSERT INTO bill_schedules (id, user_id, source_account_id, biller_id, biller_name, product_id, customer_id, amount_minor, frequency, next_run_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING `+scheduleCols,
			id, p.UserID, n.Pay.Source, b.ID, b.Name, product, customerID, n.Pay.Amount.Amount(), n.Frequency, n.StartAt.UTC()))
		return err
	})
	if err != nil {
		var pe *problem.Error
		if errors.As(err, &pe) {
			return Schedule{}, pe
		}
		return Schedule{}, fmt.Errorf("create schedule: %w", err)
	}
	return sc, nil
}

// Schedules lists the caller's scheduled bills, newest first.
func (s *Service) Schedules(ctx context.Context) ([]Schedule, error) {
	p, err := caller(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `SELECT `+scheduleCols+` FROM bill_schedules WHERE user_id = $1 ORDER BY created_at DESC, id DESC`, p.UserID)
	if err != nil {
		return nil, fmt.Errorf("list schedules: %w", err)
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Schedule, error) { return scanSchedule(r) })
	if err != nil {
		return nil, fmt.Errorf("read schedules: %w", err)
	}
	return out, nil
}

// CancelSchedule ends a scheduled bill. Cancelling one that already ended changes nothing.
func (s *Service) CancelSchedule(ctx context.Context, id uuid.UUID) error {
	p, err := caller(ctx)
	if err != nil {
		return err
	}
	tag, err := s.pool.Exec(ctx, `
UPDATE bill_schedules SET status = 'cancelled', next_run_at = NULL, updated_at = $3
WHERE id = $1 AND user_id = $2 AND status IN ('active', 'paused')`, id, p.UserID, s.now())
	if err != nil {
		return fmt.Errorf("cancel schedule: %w", err)
	}
	if tag.RowsAffected() == 0 {
		var exists bool
		if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM bill_schedules WHERE id = $1 AND user_id = $2)`, id, p.UserID).Scan(&exists); err != nil {
			return fmt.Errorf("check schedule: %w", err)
		}
		if !exists {
			return ErrScheduleNotFound
		}
	}
	return nil
}

// nextAfter is the run after "at", or false when the schedule is done.
func nextAfter(frequency string, at time.Time) (time.Time, bool) {
	switch frequency {
	case "daily":
		return at.AddDate(0, 0, 1), true
	case "weekly":
		return at.AddDate(0, 0, 7), true
	case "monthly":
		return at.AddDate(0, 1, 0), true
	}
	return time.Time{}, false
}

// RunDueSchedules pays the bills that are due. Each schedule is claimed (moved to its next run)
// before it is paid, so a crash between the two skips a run, never pays it twice. A payment the
// bank refuses (funds, limits, a biller that says no) is recorded on the schedule and the next
// run still happens.
func (s *Service) RunDueSchedules(ctx context.Context) error {
	rows, err := s.pool.Query(ctx, `SELECT id FROM bill_schedules WHERE status = 'active' AND next_run_at <= $1 ORDER BY next_run_at LIMIT $2`, s.now(), scheduleBatch)
	if err != nil {
		return fmt.Errorf("list due schedules: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return fmt.Errorf("read due schedules: %w", err)
	}
	var errs []error
	for _, id := range ids {
		if err := s.runSchedule(ctx, id); err != nil {
			s.log.ErrorContext(ctx, "scheduled bill run failed", "schedule_id", id.String(), "error", err)
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (s *Service) runSchedule(ctx context.Context, id uuid.UUID) error {
	var (
		userID, source uuid.UUID
		billerID, cust string
		product        *string
		minor          int64
	)
	claimed := false
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var frequency string
		var at time.Time
		err := tx.QueryRow(ctx, `
SELECT user_id, source_account_id, biller_id, product_id, customer_id, amount_minor, frequency, next_run_at
FROM bill_schedules WHERE id = $1 AND status = 'active' AND next_run_at <= $2 FOR UPDATE SKIP LOCKED`, id, s.now()).
			Scan(&userID, &source, &billerID, &product, &cust, &minor, &frequency, &at)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // another runner has it, or it was cancelled meanwhile
		}
		if err != nil {
			return fmt.Errorf("claim schedule: %w", err)
		}
		next, more := nextAfter(frequency, at)
		if more {
			_, err = tx.Exec(ctx, `UPDATE bill_schedules SET next_run_at = $2, run_count = run_count + 1, updated_at = $3 WHERE id = $1`, id, next, s.now())
		} else {
			_, err = tx.Exec(ctx, `UPDATE bill_schedules SET status = 'completed', next_run_at = NULL, run_count = run_count + 1, updated_at = $2 WHERE id = $1`, id, s.now())
		}
		claimed = err == nil
		return err
	})
	if err != nil || !claimed {
		return err
	}
	req := PayRequest{BillerID: billerID, CustomerID: cust, Amount: money.New(minor, money.NGN), Source: source, Scheduled: true}
	if product != nil {
		req.ProductID = *product
	}
	result := "completed"
	// The run has no device: the customer set the schedule up with their signed request.
	if _, err := s.Pay(identity.WithPrincipal(ctx, identity.Principal{UserID: userID}), req); err != nil {
		var pe *problem.Error
		if !errors.As(err, &pe) || pe.Status >= http.StatusInternalServerError {
			result = "failed"
			s.log.ErrorContext(ctx, "scheduled bill payment failed", "schedule_id", id.String(), "error", err)
		} else {
			result = pe.Title
		}
	}
	if _, err := s.pool.Exec(ctx, `UPDATE bill_schedules SET last_result = $2 WHERE id = $1`, id, result); err != nil {
		return fmt.Errorf("record run: %w", err)
	}
	return nil
}

// ScheduleArgs is the runner's periodic job.
type ScheduleArgs struct{}

// Kind implements river.JobArgs.
func (ScheduleArgs) Kind() string { return "bill_schedules_run" }

type scheduleWorker struct {
	river.WorkerDefaults[ScheduleArgs]
	s *Service
}

func (w *scheduleWorker) Work(ctx context.Context, _ *river.Job[ScheduleArgs]) error {
	return w.s.RunDueSchedules(ctx)
}
