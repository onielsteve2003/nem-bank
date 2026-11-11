// Package savings is the Grow tab's money: savings goals with auto-save and round-ups
// (T28.2), then locked savings and daily interest (T28.3).
//
// A goal's money lives in its own ledger account, so a deposit or withdrawal is an
// ordinary ledger entry between the customer's naira account and the goal. The balance
// shown is always the ledger's. Nothing here edits a balance.
package savings

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts/accountsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/savings/savingsdb"
)

// Policy. Each number has a reason.
const (
	// maxActiveGoals keeps one customer from opening endless ledger accounts.
	maxActiveGoals = 20
	// maxTarget is ₦1 billion in kobo: far above any real goal, and small enough that
	// progress arithmetic cannot overflow.
	maxTarget = 1_000_000_000_00
	// defaultGoalRateBps is the yearly rate a goal earns: 10% (SAV-5, demo value).
	defaultGoalRateBps = 1_000
)

// lagos is West Africa Time (no daylight saving): savings dates are Lagos calendar days.
var lagos = time.FixedZone("WAT", 60*60)

// Problems, with the mock bank's codes.
var (
	// ErrGoalNotFound is the 404 for a goal the caller does not have.
	ErrGoalNotFound = problem.NotFound("Goal")
	// ErrLockNotFound is the 404 for a locked saving the caller does not have.
	ErrLockNotFound = problem.NotFound("Locked saving")

	errNaira      = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "Goals are saved in naira")
	errNotActive  = problem.New(http.StatusForbidden, "account_not_active", "This account cannot be used right now")
	errGoalClosed = problem.New(http.StatusConflict, "invalid_state", "This goal is closed")
	errTooMany    = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "You have too many goals").
			WithDetailf("Close one before opening another (the limit is %d).", maxActiveGoals)
)

// Accounts is the customer's accounts; *accounts.Service implements it.
type Accounts interface {
	Owned(ctx context.Context, userID, accountID uuid.UUID) (accountsdb.GetCustomerAccountRow, error)
	Naira(ctx context.Context, userID uuid.UUID) (accountsdb.CustomerAccount, error)
}

var _ Accounts = (*accounts.Service)(nil)

// Config holds the service's dependencies.
type Config struct {
	Pool     *pgxpool.Pool
	Accounts Accounts
	Logger   *slog.Logger
	// Now defaults to time.Now.
	Now func() time.Time
}

// Service is the savings domain.
type Service struct {
	pool     *pgxpool.Pool
	q        *savingsdb.Queries
	accounts Accounts
	log      *slog.Logger
	now      func() time.Time
}

// NewService builds the service.
func NewService(cfg Config) (*Service, error) {
	if cfg.Pool == nil || cfg.Accounts == nil || cfg.Logger == nil {
		return nil, errors.New("savings: pool, accounts and logger are required")
	}
	s := &Service{pool: cfg.Pool, q: savingsdb.New(cfg.Pool), accounts: cfg.Accounts, log: cfg.Logger.With("component", "savings"), now: cfg.Now}
	if s.now == nil {
		s.now = time.Now
	}
	return s, nil
}

// AutoSave is a standing rule that moves money into a goal (SAV-2).
type AutoSave struct {
	Amount    money.Money
	Frequency string
	Source    uuid.UUID
}

// Goal is a savings goal (contract SavingsGoal).
type Goal struct {
	ID             uuid.UUID
	Name, Emoji    string
	Target         money.Money
	Balance        money.Money
	ProgressPct    int
	TargetDate     *time.Time
	AutoSave       *AutoSave
	InterestRate   int
	InterestEarned money.Money
	Status         string
	CreatedAt      time.Time
}

func principal(ctx context.Context) (identity.Principal, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return identity.Principal{}, problem.Unauthorized()
	}
	return p, nil
}

// lagosDay is the Lagos calendar day containing t, as midnight UTC (what a date column holds).
func lagosDay(t time.Time) time.Time {
	y, m, d := t.In(lagos).Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

func naira(minor int64) money.Money { return money.New(minor, money.NGN) }

func reference(prefix string, id uuid.UUID) string {
	return prefix + "-" + strings.ToUpper(strings.ReplaceAll(id.String(), "-", "")[20:])
}

func toGoal(g savingsdb.SavingsGoal, balanceMinor int64) Goal {
	out := Goal{
		ID: g.ID, Name: g.Name, Emoji: g.Emoji, Target: naira(g.TargetMinor), Balance: naira(balanceMinor),
		TargetDate: g.TargetDate, InterestRate: int(g.InterestRateBps), InterestEarned: naira(g.InterestEarnedMinor),
		Status: g.Status, CreatedAt: g.CreatedAt.UTC(),
	}
	if g.AutoSaveAmountMinor != nil {
		out.AutoSave = &AutoSave{Amount: naira(*g.AutoSaveAmountMinor), Frequency: deref(g.AutoSaveFrequency), Source: *g.AutoSaveSourceID}
	}
	// Both are bounded (target <= maxTarget), so the product cannot overflow.
	if g.TargetMinor > 0 && balanceMinor > 0 {
		out.ProgressPct = int(min(100, balanceMinor*100/g.TargetMinor))
	}
	if g.Status == "active" && balanceMinor >= g.TargetMinor {
		out.Status = "completed"
	}
	return out
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// GoalInput is what creating or editing a goal carries.
type GoalInput struct {
	Name, Emoji string
	Target      money.Money
	TargetDate  *time.Time
	AutoSave    *AutoSave
}

func (s *Service) checkText(name, emoji string) (string, error) {
	name = strings.TrimSpace(name)
	var fields []api.FieldError
	if n := utf8.RuneCountInString(name); n < 1 || n > 40 {
		fields = append(fields, problem.Field("/name", "length", "Give your goal a name of up to 40 characters."))
	}
	if n := utf8.RuneCountInString(emoji); n < 1 || n > 8 {
		fields = append(fields, problem.Field("/emoji", "length", "Pick an emoji."))
	}
	if len(fields) > 0 {
		return "", problem.Validation(fields...)
	}
	return name, nil
}

func (s *Service) checkTarget(target money.Money) error {
	switch {
	case target.Currency() != money.NGN:
		return errNaira
	case !target.IsPositive() || target.Amount() > maxTarget:
		return problem.Validation(problem.Field("/target", "range", "Enter a target between ₦1 and ₦1,000,000,000."))
	}
	return nil
}

func (s *Service) checkDate(d *time.Time) error {
	if d != nil && d.Before(lagosDay(s.now())) {
		return problem.Validation(problem.Field("/target_date", "past", "Pick a date that has not passed."))
	}
	return nil
}

// checkAutoSave validates a rule and that the source is the caller's active naira account.
func (s *Service) checkAutoSave(ctx context.Context, userID uuid.UUID, r *AutoSave) error {
	if r == nil {
		return nil
	}
	if r.Amount.Currency() != money.NGN {
		return errNaira
	}
	if !r.Amount.IsPositive() || r.Amount.Amount() > maxTarget {
		return problem.Validation(problem.Field("/auto_save/amount", "range", "Enter an amount above zero."))
	}
	switch r.Frequency {
	case "daily", "weekly", "monthly":
	default:
		return problem.Validation(problem.Field("/auto_save/frequency", "invalid", "Pick daily, weekly or monthly."))
	}
	src, err := s.accounts.Owned(ctx, userID, r.Source)
	if err != nil {
		return err
	}
	if src.Currency != string(money.NGN) {
		return errNaira
	}
	return nil
}

// Create opens a savings goal (SAV-2).
func (s *Service) Create(ctx context.Context, in GoalInput) (Goal, error) {
	p, err := principal(ctx)
	if err != nil {
		return Goal{}, err
	}
	name, err := s.checkText(in.Name, in.Emoji)
	if err != nil {
		return Goal{}, err
	}
	if err := s.checkTarget(in.Target); err != nil {
		return Goal{}, err
	}
	if err := s.checkDate(in.TargetDate); err != nil {
		return Goal{}, err
	}
	if err := s.checkAutoSave(ctx, p.UserID, in.AutoSave); err != nil {
		return Goal{}, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return Goal{}, fmt.Errorf("goal id: %w", err)
	}
	now := s.now().UTC()
	params := savingsdb.InsertGoalParams{
		ID: id, UserID: p.UserID, Name: name, Emoji: in.Emoji, TargetMinor: in.Target.Amount(), TargetDate: in.TargetDate,
		InterestPaidTo: lagosDay(now), CreatedAt: now,
	}
	setRule(&params.AutoSaveAmountMinor, &params.AutoSaveFrequency, &params.AutoSaveSourceID, &params.AutoSaveNextAt, in.AutoSave, now)

	var row savingsdb.SavingsGoal
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := savingsdb.New(tx)
		// Counted inside the transaction that adds the goal. Two goals opened at the same
		// instant can both pass, which costs one extra goal, never money.
		if n, err := q.CountActiveGoals(ctx, p.UserID); err != nil {
			return fmt.Errorf("count goals: %w", err)
		} else if n >= maxActiveGoals {
			return errTooMany
		}
		if params.AccountID, err = ledger.OpenCustomerAccount(ctx, tx, p.UserID, "customer_savings", string(money.NGN), "Savings goal"); err != nil {
			return err
		}
		if row, err = q.InsertGoal(ctx, params); err != nil {
			return fmt.Errorf("insert goal: %w", err)
		}
		return nil
	})
	if err != nil {
		return Goal{}, err
	}
	return toGoal(row, 0), nil
}

// setRule fills the four auto-save columns from a rule, or clears them when r is nil.
func setRule(amount **int64, freq **string, source **uuid.UUID, next **time.Time, r *AutoSave, from time.Time) {
	*amount, *freq, *source, *next = nil, nil, nil, nil
	if r == nil {
		return
	}
	a, f, src, n := r.Amount.Amount(), r.Frequency, r.Source, nextAutoSave(from, r.Frequency)
	*amount, *freq, *source, *next = &a, &f, &src, &n
}

// Get reads one of the caller's goals.
func (s *Service) Get(ctx context.Context, id uuid.UUID) (Goal, error) {
	p, err := principal(ctx)
	if err != nil {
		return Goal{}, err
	}
	return s.get(ctx, s.q, p.UserID, id)
}

func (s *Service) get(ctx context.Context, q *savingsdb.Queries, userID, id uuid.UUID) (Goal, error) {
	row, err := q.GetGoal(ctx, savingsdb.GetGoalParams{ID: id, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Goal{}, ErrGoalNotFound
	}
	if err != nil {
		return Goal{}, fmt.Errorf("load goal: %w", err)
	}
	return toGoal(row.SavingsGoal, row.BalanceMinor), nil
}

// List returns the caller's goals, active first.
func (s *Service) List(ctx context.Context) ([]Goal, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListGoals(ctx, p.UserID)
	if err != nil {
		return nil, fmt.Errorf("list goals: %w", err)
	}
	out := make([]Goal, len(rows))
	for i, r := range rows {
		out[i] = toGoal(r.SavingsGoal, r.BalanceMinor)
	}
	return out, nil
}

// Edit is a change to a goal. A nil field is left alone; ClearTargetDate and ClearAutoSave
// remove the date or the rule (the contract's explicit null).
type Edit struct {
	Name, Emoji     *string
	Target          *money.Money
	TargetDate      *time.Time
	ClearTargetDate bool
	AutoSave        *AutoSave
	ClearAutoSave   bool
}

// Update edits a goal. Changing the auto-save rule restarts its clock from now.
func (s *Service) Update(ctx context.Context, id uuid.UUID, e Edit) (Goal, error) {
	p, err := principal(ctx)
	if err != nil {
		return Goal{}, err
	}
	if _, err := s.Get(ctx, id); err != nil {
		return Goal{}, err
	}
	if e.Target != nil {
		if err := s.checkTarget(*e.Target); err != nil {
			return Goal{}, err
		}
	}
	if err := s.checkDate(e.TargetDate); err != nil {
		return Goal{}, err
	}
	if err := s.checkAutoSave(ctx, p.UserID, e.AutoSave); err != nil {
		return Goal{}, err
	}
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := savingsdb.New(tx)
		g, err := q.LockGoal(ctx, id)
		if err != nil {
			return fmt.Errorf("lock goal: %w", err)
		}
		if g.Status != "active" {
			return errGoalClosed
		}
		params := savingsdb.UpdateGoalParams{
			ID: id, Name: g.Name, Emoji: g.Emoji, TargetMinor: g.TargetMinor, TargetDate: g.TargetDate,
			AutoSaveAmountMinor: g.AutoSaveAmountMinor, AutoSaveFrequency: g.AutoSaveFrequency,
			AutoSaveSourceID: g.AutoSaveSourceID, AutoSaveNextAt: g.AutoSaveNextAt,
		}
		if e.Name != nil || e.Emoji != nil {
			name, emoji := g.Name, g.Emoji
			if e.Name != nil {
				name = *e.Name
			}
			if e.Emoji != nil {
				emoji = *e.Emoji
			}
			if params.Name, err = s.checkText(name, emoji); err != nil {
				return err
			}
			params.Emoji = emoji
		}
		if e.Target != nil {
			params.TargetMinor = e.Target.Amount()
		}
		switch {
		case e.ClearTargetDate:
			params.TargetDate = nil
		case e.TargetDate != nil:
			params.TargetDate = e.TargetDate
		}
		switch {
		case e.ClearAutoSave:
			setRule(&params.AutoSaveAmountMinor, &params.AutoSaveFrequency, &params.AutoSaveSourceID, &params.AutoSaveNextAt, nil, s.now())
		case e.AutoSave != nil:
			setRule(&params.AutoSaveAmountMinor, &params.AutoSaveFrequency, &params.AutoSaveSourceID, &params.AutoSaveNextAt, e.AutoSave, s.now())
		}
		if _, err := q.UpdateGoal(ctx, params); err != nil {
			return fmt.Errorf("update goal: %w", err)
		}
		return nil
	})
	if err != nil {
		return Goal{}, err
	}
	return s.Get(ctx, id)
}

// Deposit moves money from the caller's naira account into a goal.
func (s *Service) Deposit(ctx context.Context, goalID, from uuid.UUID, amount money.Money) (Goal, error) {
	return s.move(ctx, goalID, from, amount, true)
}

// Withdraw moves money from a goal back to the caller's naira account.
func (s *Service) Withdraw(ctx context.Context, goalID, to uuid.UUID, amount money.Money) (Goal, error) {
	return s.move(ctx, goalID, to, amount, false)
}

func (s *Service) move(ctx context.Context, goalID, accountID uuid.UUID, amount money.Money, deposit bool) (Goal, error) {
	p, err := principal(ctx)
	if err != nil {
		return Goal{}, err
	}
	if amount.Currency() != money.NGN {
		return Goal{}, errNaira
	}
	if !amount.IsPositive() {
		return Goal{}, problem.Validation(problem.Field("/amount", "positive", "Enter an amount above zero."))
	}
	if _, err := s.Get(ctx, goalID); err != nil {
		return Goal{}, err
	}
	acc, err := s.accounts.Owned(ctx, p.UserID, accountID)
	if err != nil {
		return Goal{}, err
	}
	if acc.Status != "active" {
		return Goal{}, errNotActive
	}
	if acc.Currency != string(money.NGN) {
		return Goal{}, errNaira
	}
	lineID, err := uuid.NewV7()
	if err != nil {
		return Goal{}, fmt.Errorf("movement id: %w", err)
	}
	now := s.now().UTC()
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		g, err := savingsdb.New(tx).LockGoal(ctx, goalID)
		if err != nil {
			return fmt.Errorf("lock goal: %w", err)
		}
		if g.Status != "active" {
			return errGoalClosed
		}
		narration, direction, legs := "Saved to "+g.Name, "debit", []ledger.Leg{ledger.Debit(acc.AccountID, amount), ledger.Credit(g.AccountID, amount)}
		if !deposit {
			narration, direction, legs = "Withdrew from "+g.Name, "credit", []ledger.Leg{ledger.Debit(g.AccountID, amount), ledger.Credit(acc.AccountID, amount)}
		}
		ref := reference("SAV", lineID)
		posted, err := ledger.Post(ctx, tx, ledger.Entry{
			Kind: "savings", Reference: ref, IdempotencyKey: "savings:" + lineID.String(),
			Metadata: map[string]any{"goal_id": g.ID.String(), "deposit": deposit}, Legs: legs,
		})
		if err != nil {
			return err
		}
		return s.record(ctx, tx, accounts.Line{
			ID: lineID, UserID: p.UserID, AccountID: acc.AccountID, Type: "savings", Direction: direction, Status: "completed",
			Amount: amount, Entry: &posted, Narration: narration, Reference: ref, Category: "savings", At: now,
		})
	})
	if err != nil {
		return Goal{}, err
	}
	return s.Get(ctx, goalID)
}

// record writes a savings history line on a customer account.
func (s *Service) record(ctx context.Context, tx pgx.Tx, l accounts.Line) error {
	l.Counterparty = api.Counterparty{Name: "Nem Savings"}
	_, err := accounts.Record(ctx, tx, l)
	return err
}

// Close pays any balance back to the naira account and closes the goal. Closing a closed
// goal does nothing, so a retry is safe.
func (s *Service) Close(ctx context.Context, id uuid.UUID) error {
	p, err := principal(ctx)
	if err != nil {
		return err
	}
	if _, err := s.Get(ctx, id); err != nil {
		return err
	}
	home, err := s.accounts.Naira(ctx, p.UserID)
	if err != nil {
		return err
	}
	lineID, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("movement id: %w", err)
	}
	now := s.now().UTC()
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := savingsdb.New(tx)
		g, err := q.LockGoal(ctx, id)
		if err != nil {
			return fmt.Errorf("lock goal: %w", err)
		}
		if g.Status == "closed" {
			return nil
		}
		bal, err := ledger.GetBalances(ctx, tx, g.AccountID)
		if err != nil {
			return fmt.Errorf("goal balance: %w", err)
		}
		if bal.Ledger.IsPositive() {
			if home.Status != "active" {
				return errNotActive
			}
			ref := reference("SAV", lineID)
			posted, err := ledger.Post(ctx, tx, ledger.Entry{
				Kind: "savings", Reference: ref, IdempotencyKey: "savings_close:" + g.ID.String(),
				Metadata: map[string]any{"goal_id": g.ID.String(), "close": true},
				Legs:     []ledger.Leg{ledger.Debit(g.AccountID, bal.Ledger), ledger.Credit(home.AccountID, bal.Ledger)},
			})
			if err != nil {
				return err
			}
			if err := s.record(ctx, tx, accounts.Line{
				ID: lineID, UserID: p.UserID, AccountID: home.AccountID, Type: "savings", Direction: "credit", Status: "completed",
				Amount: bal.Ledger, Entry: &posted, Narration: "Closed " + g.Name, Reference: ref, Category: "savings", At: now,
			}); err != nil {
				return err
			}
		}
		if _, err := q.CloseGoal(ctx, savingsdb.CloseGoalParams{ID: id, At: &now}); err != nil {
			return fmt.Errorf("close goal: %w", err)
		}
		// Round-ups pointed at a closed goal would go nowhere: switch them off.
		if err := q.ClearRoundUpGoal(ctx, &id); err != nil {
			return fmt.Errorf("clear round-up goal: %w", err)
		}
		return nil
	})
}

// Summary is the Grow tab overview (contract SavingsSummary).
type Summary struct {
	TotalSaved, InterestEarned, RoundUpsThisMonth money.Money
	Goals, Locks                                  int
}

// Summary adds up what the caller has saved (SAV-1).
func (s *Service) Summary(ctx context.Context) (Summary, error) {
	p, err := principal(ctx)
	if err != nil {
		return Summary{}, err
	}
	t, err := s.q.GoalTotals(ctx, p.UserID)
	if err != nil {
		return Summary{}, fmt.Errorf("goal totals: %w", err)
	}
	y, m, _ := s.now().In(lagos).Date()
	monthStart := time.Date(y, m, 1, 0, 0, 0, 0, lagos)
	ru, err := s.q.SumRoundUpsSince(ctx, savingsdb.SumRoundUpsSinceParams{UserID: p.UserID, Since: monthStart})
	if err != nil {
		return Summary{}, fmt.Errorf("round-ups this month: %w", err)
	}
	locks, err := s.q.LockTotals(ctx, p.UserID)
	if err != nil {
		return Summary{}, fmt.Errorf("lock totals: %w", err)
	}
	return Summary{
		TotalSaved: naira(t.Saved + locks.Locked), InterestEarned: naira(t.Interest + locks.Interest),
		RoundUpsThisMonth: naira(ru), Goals: int(t.Goals), Locks: int(locks.Running),
	}, nil
}

// emit writes a savings event in the caller's transaction (notifications subscribe later).
func emit(ctx context.Context, tx pgx.Tx, topic string, goalID uuid.UUID, payload map[string]any) error {
	if _, err := jobs.Write(ctx, tx, jobs.Event{Topic: topic, AggregateType: "savings_goal", AggregateID: goalID.String(), Payload: payload}); err != nil {
		return fmt.Errorf("write %s event: %w", topic, err)
	}
	return nil
}
