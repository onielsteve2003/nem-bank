// Package insights answers "where did my money go": the monthly spending breakdown, budgets per
// category and the monthly money story (PRD FR-INS). Everything is read from the customer's
// own transaction history; nothing here moves money.
package insights

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// lagos is Africa/Lagos: UTC+1 all year, so a fixed zone is exact and needs no tz database.
var lagos = time.FixedZone("WAT", 3600)

// notSpending are the types that move money between the customer's own pots, or undo a payment:
// none of them is spending.
var notSpending = []string{"fx_conversion", "savings", "ajo", "loan_repayment", "reversal"}

var errBudgetExists = problem.New(http.StatusConflict, "budget_exists", "You already have a budget for this category")

// Customers gives the duress flag; *identity.Service implements it.
type Customers interface {
	CustomerProfile(ctx context.Context, userID uuid.UUID) (identity.CustomerProfile, error)
}

var _ Customers = (*identity.Service)(nil)

// Config holds the service's dependencies.
type Config struct {
	Pool      *pgxpool.Pool
	Customers Customers
	// Now defaults to time.Now.
	Now func() time.Time
}

// Service reads spending and keeps budgets.
type Service struct {
	pool *pgxpool.Pool
	cust Customers
	now  func() time.Time
}

// NewService returns the insights service.
func NewService(c Config) (*Service, error) {
	if c.Pool == nil || c.Customers == nil {
		return nil, errors.New("insights: pool and customers are required")
	}
	now := c.Now
	if now == nil {
		now = time.Now
	}
	return &Service{pool: c.Pool, cust: c.Customers, now: now}, nil
}

// caller is the signed-in customer and whether they are looking at the duress decoy.
func (s *Service) caller(ctx context.Context) (uuid.UUID, bool, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return uuid.Nil, false, problem.Unauthorized()
	}
	profile, err := s.cust.CustomerProfile(ctx, p.UserID)
	if err != nil {
		return uuid.Nil, false, err
	}
	return p.UserID, profile.InDuress, nil
}

// Month is a calendar month in Lagos.
type Month struct{ Year, Num int }

func (m Month) String() string { return fmt.Sprintf("%04d-%02d", m.Year, m.Num) }

func (m Month) start() time.Time { return time.Date(m.Year, time.Month(m.Num), 1, 0, 0, 0, 0, lagos) }

// Previous is the month before.
func (m Month) Previous() Month {
	if m.Num == 1 {
		return Month{m.Year - 1, 12}
	}
	return Month{m.Year, m.Num - 1}
}

func monthOf(t time.Time) Month {
	t = t.In(lagos)
	return Month{t.Year(), int(t.Month())}
}

// ParseMonth reads "2026-11"; an empty string is def.
func ParseMonth(s string, def Month) (Month, error) {
	if s == "" {
		return def, nil
	}
	t, err := time.Parse("2006-01", s)
	if err != nil {
		return Month{}, problem.Validation(problem.Field("/month", "bad_format", "Use YYYY-MM"))
	}
	return Month{t.Year(), int(t.Month())}, nil
}

// CategorySpend is what one category took in a month.
type CategorySpend struct {
	Category string
	Amount   int64
	Share    int
	Previous int64
}

// Breakdown is a month's spending against the month before.
type Breakdown struct {
	Month         Month
	Currency      string
	Total         int64
	PreviousTotal int64
	Categories    []CategorySpend
}

// spendByCategory sums a month's completed spending per category.
func (s *Service) spendByCategory(ctx context.Context, userID uuid.UUID, currency string, m Month) (map[string]int64, error) {
	rows, err := s.pool.Query(ctx, `
SELECT category, SUM(amount_minor)::bigint
FROM transactions
WHERE user_id = $1 AND direction = 'debit' AND status = 'completed' AND currency = $2
  AND type <> ALL ($3) AND created_at >= $4 AND created_at < $5
GROUP BY category`, userID, currency, notSpending, m.start(), m.start().AddDate(0, 1, 0))
	if err != nil {
		return nil, fmt.Errorf("spend by category: %w", err)
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var c string
		var n int64
		if err := rows.Scan(&c, &n); err != nil {
			return nil, fmt.Errorf("scan spend: %w", err)
		}
		out[c] = n
	}
	return out, rows.Err()
}

// Spending is GET /v1/insights/spending.
func (s *Service) Spending(ctx context.Context, month, currency string) (Breakdown, error) {
	userID, duress, err := s.caller(ctx)
	if err != nil {
		return Breakdown{}, err
	}
	m, err := ParseMonth(month, monthOf(s.now()))
	if err != nil {
		return Breakdown{}, err
	}
	if currency == "" {
		currency = "NGN"
	}
	out := Breakdown{Month: m, Currency: currency, Categories: []CategorySpend{}}
	if duress {
		return out, nil // the decoy view has no history
	}
	now, err := s.spendByCategory(ctx, userID, currency, m)
	if err != nil {
		return Breakdown{}, err
	}
	before, err := s.spendByCategory(ctx, userID, currency, m.Previous())
	if err != nil {
		return Breakdown{}, err
	}
	for _, n := range before {
		out.PreviousTotal += n
	}
	for c, n := range now {
		out.Total += n
		out.Categories = append(out.Categories, CategorySpend{Category: c, Amount: n, Previous: before[c]})
	}
	// Biggest first; equal amounts by name so the order never flickers.
	slices.SortFunc(out.Categories, func(a, b CategorySpend) int {
		if a.Amount != b.Amount {
			if a.Amount > b.Amount {
				return -1
			}
			return 1
		}
		return strings.Compare(a.Category, b.Category)
	})
	amounts := make([]int64, len(out.Categories))
	for i, c := range out.Categories {
		amounts[i] = c.Amount
	}
	for i, share := range Shares(amounts) {
		out.Categories[i].Share = share
	}
	return out, nil
}

// Shares turns amounts into whole percents that always add up to 100 (largest remainder).
func Shares(amounts []int64) []int {
	var all int64
	for _, a := range amounts {
		all += a
	}
	out := make([]int, len(amounts))
	if all == 0 {
		return out
	}
	type rem struct {
		i int
		r int64
	}
	rems := make([]rem, len(amounts))
	left := 100
	for i, a := range amounts {
		whole, r := a*100/all, a*100%all // kobo totals stay far below the int64 limit here
		out[i] = int(whole)
		left -= int(whole)
		rems[i] = rem{i, r}
	}
	slices.SortStableFunc(rems, func(a, b rem) int {
		switch {
		case a.r > b.r:
			return -1
		case a.r < b.r:
			return 1
		}
		return 0
	})
	for _, r := range rems {
		if left <= 0 {
			break
		}
		out[r.i]++
		left--
	}
	return out
}

// Budget is a category limit with this month's spending against it.
type Budget struct {
	ID       uuid.UUID
	Category string
	Limit    int64
	Spent    int64
}

// Status is ok, warning from 80% of the limit, exceeded from 100%.
func (b Budget) Status() string {
	switch {
	case b.Limit > 0 && b.Spent >= b.Limit:
		return "exceeded"
	case b.Limit > 0 && b.Spent*5 >= b.Limit*4:
		return "warning"
	}
	return "ok"
}

func (s *Service) budgets(ctx context.Context, userID uuid.UUID, duress bool, only *uuid.UUID) ([]Budget, error) {
	rows, err := s.pool.Query(ctx, `
SELECT id, category, limit_minor FROM budgets WHERE user_id = $1 AND ($2::uuid IS NULL OR id = $2) ORDER BY created_at, id`,
		userID, only)
	if err != nil {
		return nil, fmt.Errorf("list budgets: %w", err)
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Budget, error) {
		var b Budget
		return b, r.Scan(&b.ID, &b.Category, &b.Limit)
	})
	if err != nil {
		return nil, fmt.Errorf("read budgets: %w", err)
	}
	if duress || len(out) == 0 {
		return out, nil
	}
	spent, err := s.spendByCategory(ctx, userID, "NGN", monthOf(s.now()))
	if err != nil {
		return nil, err
	}
	for i := range out {
		out[i].Spent = spent[out[i].Category]
	}
	return out, nil
}

// ListBudgets is GET /v1/insights/budgets.
func (s *Service) ListBudgets(ctx context.Context) ([]Budget, error) {
	userID, duress, err := s.caller(ctx)
	if err != nil {
		return nil, err
	}
	return s.budgets(ctx, userID, duress, nil)
}

func limitProblem(currency string, minor int64) error {
	if currency != "NGN" {
		return problem.Validation(problem.Field("/limit", "currency", "Budgets are in naira"))
	}
	if minor <= 0 {
		return problem.Validation(problem.Field("/limit", "positive", "Enter an amount above zero"))
	}
	return nil
}

// CreateBudget is POST /v1/insights/budgets.
func (s *Service) CreateBudget(ctx context.Context, category, currency string, limitMinor int64) (Budget, error) {
	userID, duress, err := s.caller(ctx)
	if err != nil {
		return Budget{}, err
	}
	if err := limitProblem(currency, limitMinor); err != nil {
		return Budget{}, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return Budget{}, fmt.Errorf("new id: %w", err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO budgets (id, user_id, category, limit_minor) VALUES ($1, $2, $3, $4)`,
		id, userID, category, limitMinor); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return Budget{}, errBudgetExists
		}
		return Budget{}, fmt.Errorf("create budget: %w", err)
	}
	return s.one(ctx, userID, duress, id)
}

// UpdateBudget is PATCH /v1/insights/budgets/{id}.
func (s *Service) UpdateBudget(ctx context.Context, id uuid.UUID, currency string, limitMinor int64) (Budget, error) {
	userID, duress, err := s.caller(ctx)
	if err != nil {
		return Budget{}, err
	}
	if err := limitProblem(currency, limitMinor); err != nil {
		return Budget{}, err
	}
	tag, err := s.pool.Exec(ctx, `UPDATE budgets SET limit_minor = $3, updated_at = now() WHERE id = $1 AND user_id = $2`, id, userID, limitMinor)
	if err != nil {
		return Budget{}, fmt.Errorf("update budget: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return Budget{}, problem.NotFound("Budget")
	}
	return s.one(ctx, userID, duress, id)
}

// DeleteBudget is DELETE /v1/insights/budgets/{id}.
func (s *Service) DeleteBudget(ctx context.Context, id uuid.UUID) error {
	userID, _, err := s.caller(ctx)
	if err != nil {
		return err
	}
	tag, err := s.pool.Exec(ctx, `DELETE FROM budgets WHERE id = $1 AND user_id = $2`, id, userID)
	if err != nil {
		return fmt.Errorf("delete budget: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return problem.NotFound("Budget")
	}
	return nil
}

func (s *Service) one(ctx context.Context, userID uuid.UUID, duress bool, id uuid.UUID) (Budget, error) {
	list, err := s.budgets(ctx, userID, duress, &id)
	if err != nil {
		return Budget{}, err
	}
	if len(list) == 0 {
		return Budget{}, problem.NotFound("Budget")
	}
	return list[0], nil
}

// Slide is one card of the money story.
type Slide struct {
	Kind     string
	Title    string
	Body     string
	Amount   *int64
	Category string
}

// Story is a month told as a few slides.
type Story struct {
	Month  Month
	Slides []Slide
}

// naira writes kobo as "₦12,345" (or "₦12,345.50" when there are kobo).
func naira(minor int64) string {
	neg := minor < 0
	if neg {
		minor = -minor
	}
	whole := strconv.FormatInt(minor/100, 10)
	var b strings.Builder
	for i, ch := range whole {
		if i > 0 && (len(whole)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(ch)
	}
	out := "₦" + b.String()
	if k := minor % 100; k != 0 {
		out += fmt.Sprintf(".%02d", k)
	}
	if neg {
		out = "-" + out
	}
	return out
}

func categoryLabel(c string) string { return strings.ReplaceAll(c, "_", " ") }

// MoneyStory is GET /v1/insights/money-story. Without a month it tells last month.
func (s *Service) MoneyStory(ctx context.Context, month string) (Story, error) {
	userID, duress, err := s.caller(ctx)
	if err != nil {
		return Story{}, err
	}
	m, err := ParseMonth(month, monthOf(s.now()).Previous())
	if err != nil {
		return Story{}, err
	}
	b, err := s.Spending(ctx, m.String(), "NGN")
	if err != nil {
		return Story{}, err
	}
	var count int
	var biggestDay time.Time
	var biggest, saved int64
	if !duress {
		if err := s.pool.QueryRow(ctx, `
SELECT COUNT(*)::int FROM transactions
WHERE user_id = $1 AND direction = 'debit' AND status = 'completed' AND currency = 'NGN'
  AND type <> ALL ($2) AND created_at >= $3 AND created_at < $4`,
			userID, notSpending, m.start(), m.start().AddDate(0, 1, 0)).Scan(&count); err != nil {
			return Story{}, fmt.Errorf("count payments: %w", err)
		}
		err := s.pool.QueryRow(ctx, `
SELECT (created_at AT TIME ZONE 'Africa/Lagos')::date AS d, SUM(amount_minor)::bigint AS total
FROM transactions
WHERE user_id = $1 AND direction = 'debit' AND status = 'completed' AND currency = 'NGN'
  AND type <> ALL ($2) AND created_at >= $3 AND created_at < $4
GROUP BY d ORDER BY total DESC, d LIMIT 1`,
			userID, notSpending, m.start(), m.start().AddDate(0, 1, 0)).Scan(&biggestDay, &biggest)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return Story{}, fmt.Errorf("biggest day: %w", err)
		}
		if err := s.pool.QueryRow(ctx, `
SELECT COALESCE(SUM(amount_minor), 0)::bigint FROM transactions
WHERE user_id = $1 AND type = 'savings' AND direction = 'debit' AND status = 'completed' AND currency = 'NGN'
  AND created_at >= $2 AND created_at < $3`,
			userID, m.start(), m.start().AddDate(0, 1, 0)).Scan(&saved); err != nil {
			return Story{}, fmt.Errorf("saved: %w", err)
		}
	}
	amt := func(n int64) *int64 { return &n }
	label := time.Month(m.Num).String() + " " + strconv.Itoa(m.Year)
	slides := []Slide{
		{Kind: "intro", Title: "Your " + label, Body: "Here is how your money moved this month."},
		{Kind: "total_spent", Title: "You spent", Body: fmt.Sprintf("%d payments in all.", count), Amount: amt(b.Total)},
	}
	var topName string
	if len(b.Categories) > 0 {
		top := b.Categories[0]
		topName = categoryLabel(top.Category)
		slides = append(slides, Slide{Kind: "top_category", Title: "Top category", Body: fmt.Sprintf("%d%% of your spending.", top.Share), Amount: amt(top.Amount), Category: top.Category})
	}
	if biggest > 0 {
		slides = append(slides, Slide{Kind: "biggest_day", Title: "Biggest day", Body: biggestDay.Format("Monday, 2 January") + " was your biggest spending day.", Amount: amt(biggest)})
	}
	savedBody := "Start a goal to see this grow."
	if saved > 0 {
		savedBody = "Every bit counts."
	}
	slides = append(slides, Slide{Kind: "saved", Title: "You saved", Body: savedBody, Amount: amt(saved)})
	diff := b.Total - b.PreviousTotal
	title, more := "Less than last month", "less"
	if diff > 0 {
		title, more = "A bit more than last month", "more"
	} else {
		diff = -diff
	}
	slides = append(slides, Slide{Kind: "compared", Title: title, Body: fmt.Sprintf("%s %s than the month before.", naira(diff), more), Amount: amt(b.PreviousTotal)})
	tip := "Set a budget to stay on track."
	if topName != "" {
		tip = "Set a budget for " + topName + " to keep it in check."
	}
	slides = append(slides,
		Slide{Kind: "tip", Title: "Tip", Body: tip},
		Slide{Kind: "outro", Title: "That was your month", Body: "Share it, or keep it to yourself. Your call."},
	)
	return Story{Month: m, Slides: slides}, nil
}
