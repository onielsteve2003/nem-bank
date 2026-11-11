// Package credit is the bank's small salary-backed loans (FR-CRD, T28.5): a scored
// eligibility check with reason codes, a priced offer, disbursement, a repayment schedule,
// auto-repay, early payoff and overdue handling.
//
// A loan is a receivable ledger account. Disbursement debits it with principal + interest +
// fee, so what the customer owes is always the negated ledger balance and every repayment is
// one ledger entry. The instalment table only says which part of the debt falls due when.
package credit

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts/accountsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/credit/creditdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/savings"
)

// Policy. Each number has a reason.
const (
	// feeBps is the one-off origination fee: 1% of the principal, disclosed in the offer.
	feeBps = 100
	// minLoan and loanStep keep amounts round and match the app's slider (₦5,000 steps).
	minLoan  = 5_000_00
	loanStep = 5_000_00
	// maxLoan is ₦500,000, the most the demo bank lends.
	maxLoan = 500_000_00
	// salaryShareBps is how much of a month's salary a customer may borrow: 30%.
	salaryShareBps = 3_000
	// offerTTL is how long a priced offer can be accepted.
	offerTTL = 10 * time.Minute
	// instalmentDays spaces instalments a month (30 days) apart.
	instalmentDays = 30
	// defaultAfterDays is how long an unpaid instalment may stay overdue before the loan is
	// marked defaulted.
	defaultAfterDays = 60
	// minTier is the KYC tier credit needs (KYC-7).
	minTier = 3
)

// aprByTenor is the yearly rate by tenor in days, in basis points. The contract only
// offers these four tenors.
var aprByTenor = map[int]int{30: 2_400, 60: 2_600, 90: 2_800, 180: 3_000}

// lagos is West Africa Time (no daylight saving): instalments fall on Lagos calendar days.
var lagos = time.FixedZone("WAT", 60*60)

// Problems, with the mock bank's codes.
var (
	// ErrLoanNotFound is the 404 for a loan the caller does not have.
	ErrLoanNotFound = problem.NotFound("Loan")
	// ErrOfferNotFound is the 404 for an offer the caller does not have.
	ErrOfferNotFound = problem.NotFound("Offer")

	errTier        = problem.New(http.StatusForbidden, "kyc_tier_required", "Credit needs KYC Tier 3")
	errNotEligible = problem.New(http.StatusUnprocessableEntity, "not_eligible", "You cannot borrow right now")
	errTooMuch     = problem.New(http.StatusUnprocessableEntity, "limit_exceeded", "That is more than you can borrow")
	errAmount      = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "Borrow at least ₦5,000, in steps of ₦5,000")
	errTenor       = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "Pick 30, 60, 90 or 180 days")
	errNaira       = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "Loans are paid into your naira account")
	errNotActive   = problem.New(http.StatusForbidden, "account_not_active", "This account cannot be used right now")
	errExpired     = problem.New(http.StatusGone, "offer_expired", "This offer has expired")
	errOpenLoan    = problem.New(http.StatusConflict, "loan_open", "You already have a loan to repay")
	errRepaid      = problem.New(http.StatusConflict, "invalid_state", "This loan is fully repaid")
	errTooMuchPaid = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "That is more than you owe")
)

// Accounts is the customer's accounts; *accounts.Service implements it.
type Accounts interface {
	Owned(ctx context.Context, userID, accountID uuid.UUID) (accountsdb.GetCustomerAccountRow, error)
}

// Customers gives the KYC tier; *identity.Service implements it.
type Customers interface {
	CustomerProfile(ctx context.Context, userID uuid.UUID) (identity.CustomerProfile, error)
}

var (
	_ Accounts  = (*accounts.Service)(nil)
	_ Customers = (*identity.Service)(nil)
)

// Config holds the service's dependencies.
type Config struct {
	Pool      *pgxpool.Pool
	Accounts  Accounts
	Customers Customers
	// Scorer defaults to the rules scorer; the trained model plugs in here (T29.6).
	Scorer Scorer
	Logger *slog.Logger
	// Now defaults to time.Now.
	Now func() time.Time
}

// Service is the credit domain.
type Service struct {
	pool      *pgxpool.Pool
	q         *creditdb.Queries
	accounts  Accounts
	customers Customers
	scorer    Scorer
	log       *slog.Logger
	now       func() time.Time
}

// NewService builds the service.
func NewService(cfg Config) (*Service, error) {
	if cfg.Pool == nil || cfg.Accounts == nil || cfg.Customers == nil || cfg.Logger == nil {
		return nil, errors.New("credit: pool, accounts, customers and logger are required")
	}
	s := &Service{
		pool: cfg.Pool, q: creditdb.New(cfg.Pool), accounts: cfg.Accounts, customers: cfg.Customers,
		scorer: cfg.Scorer, log: cfg.Logger.With("component", "credit"), now: cfg.Now,
	}
	if s.scorer == nil {
		s.scorer = RulesScorer{}
	}
	if s.now == nil {
		s.now = time.Now
	}
	return s, nil
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

func isUnique(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// ---- eligibility ------------------------------------------------------------------------

// Eligibility is the answer to "can I borrow, and why" (CRD-1).
type Eligibility struct {
	Eligible bool
	Max      money.Money
	Band     string
	Reasons  []Reason
	AI       Meta
	At       time.Time
}

// Eligibility scores the caller. The scorer proposes a band, a ceiling and reasons; policy
// then has the last word, so no model can lend to someone under KYC Tier 3, with a loan
// already open, or who once defaulted.
func (s *Service) Eligibility(ctx context.Context) (Eligibility, error) {
	p, err := principal(ctx)
	if err != nil {
		return Eligibility{}, err
	}
	return s.eligibility(ctx, s.q, p.UserID)
}

func (s *Service) eligibility(ctx context.Context, q *creditdb.Queries, userID uuid.UUID) (Eligibility, error) {
	profile, err := s.customers.CustomerProfile(ctx, userID)
	if err != nil {
		return Eligibility{}, err
	}
	facts, err := s.facts(ctx, q, userID)
	if err != nil {
		return Eligibility{}, err
	}
	a, err := s.scorer.Score(ctx, facts)
	if err != nil {
		return Eligibility{}, fmt.Errorf("score: %w", err)
	}
	out := Eligibility{Eligible: a.Max.Amount() > 0, Max: a.Max, Band: a.Band, Reasons: a.Reasons, AI: a.Meta, At: s.now().UTC()}
	block := func(code, message string) {
		out.Eligible = false
		out.Reasons = append(out.Reasons, Reason{Code: code, Impact: "negative", Message: message})
	}
	if profile.KycTier < minTier {
		block("kyc_tier", "Credit needs KYC Tier 3.")
	}
	if facts.OpenLoans > 0 {
		block("active_loan", "Repay your current loan first.")
	}
	if facts.DefaultedLoans > 0 {
		block("past_default", "A past loan went unpaid.")
	}
	if !out.Eligible {
		out.Max = naira(0)
	}
	return out, nil
}

func (s *Service) facts(ctx context.Context, q *creditdb.Queries, userID uuid.UUID) (Facts, error) {
	now := s.now().UTC()
	created, err := q.UserCreatedAt(ctx, userID)
	if err != nil {
		return Facts{}, fmt.Errorf("load user: %w", err)
	}
	// Three months of salary, averaged, so one late or missing month does not swing it.
	salary, err := q.SalarySince(ctx, creditdb.SalarySinceParams{UserID: userID, Since: now.AddDate(0, 0, -92)})
	if err != nil {
		return Facts{}, fmt.Errorf("salary: %w", err)
	}
	goals, err := q.CountActiveGoals(ctx, userID)
	if err != nil {
		return Facts{}, fmt.Errorf("goals: %w", err)
	}
	h, err := q.LoanHistory(ctx, userID)
	if err != nil {
		return Facts{}, fmt.Errorf("loan history: %w", err)
	}
	return Facts{
		MonthlySalary: naira(salary / 3), AccountAgeDays: int(now.Sub(created) / (24 * time.Hour)), ActiveGoals: int(goals),
		RepaidLoans: int(h.Repaid), DefaultedLoans: int(h.Defaulted), OpenLoans: int(h.Open),
	}, nil
}

// ---- pricing and schedule -------------------------------------------------------------------

// Terms is a priced loan (CRD-2): everything the customer pays is disclosed up front.
type Terms struct {
	Principal, Interest, Fee, Total money.Money
	AprBps, TenorDays               int
}

func price(principal int64, tenorDays int) (Terms, error) {
	apr, ok := aprByTenor[tenorDays]
	if !ok {
		return Terms{}, errTenor
	}
	interest := savings.SimpleInterest(principal, apr, tenorDays)
	fee := (principal*feeBps + 5_000) / 10_000 // half-up
	return Terms{
		Principal: naira(principal), Interest: naira(interest), Fee: naira(fee), Total: naira(principal + interest + fee),
		AprBps: apr, TenorDays: tenorDays,
	}, nil
}

// planned is one instalment before it exists.
type planned struct {
	Number int
	Due    time.Time
	Amount int64
}

// plan splits total into monthly instalments from start. The last carries the kobo that
// do not divide evenly.
func plan(total int64, tenorDays int, start time.Time) []planned {
	n := max(1, (tenorDays+instalmentDays/2)/instalmentDays)
	each := total / int64(n)
	out := make([]planned, n)
	for i := range out {
		amount := each
		if i == n-1 {
			amount = total - each*int64(n-1)
		}
		out[i] = planned{Number: i + 1, Due: start.AddDate(0, 0, instalmentDays*(i+1)), Amount: amount}
	}
	return out
}

// Offer is a priced, time-limited offer (contract LoanOffer).
type Offer struct {
	ID        uuid.UUID
	Terms     Terms
	Schedule  []Installment
	ExpiresAt time.Time
}

// Installment is one instalment as shown to the customer.
type Installment struct {
	Number int
	Due    time.Time
	Amount money.Money
	Paid   money.Money
	Status string
}

func installmentStatus(amount, paid int64, due, today time.Time) string {
	switch {
	case paid >= amount:
		return "paid"
	case due.Before(today):
		return "overdue"
	case due.Equal(today):
		return "due"
	default:
		return "upcoming"
	}
}

// CreateOffer prices a loan for the caller (CRD-2). It is a quote: it checks eligibility
// and the amount, saves the offer so it can be accepted, and moves no money.
func (s *Service) CreateOffer(ctx context.Context, amount money.Money, tenorDays int) (Offer, error) {
	p, err := principal(ctx)
	if err != nil {
		return Offer{}, err
	}
	if amount.Currency() != money.NGN || amount.Amount() < minLoan || amount.Amount() > maxLoan || amount.Amount()%loanStep != 0 {
		return Offer{}, errAmount
	}
	terms, err := price(amount.Amount(), tenorDays)
	if err != nil {
		return Offer{}, err
	}
	el, err := s.Eligibility(ctx)
	if err != nil {
		return Offer{}, err
	}
	if !el.Eligible {
		return Offer{}, errNotEligible
	}
	if amount.Amount() > el.Max.Amount() {
		return Offer{}, errTooMuch
	}
	id, err := uuid.NewV7()
	if err != nil {
		return Offer{}, fmt.Errorf("offer id: %w", err)
	}
	now := s.now().UTC()
	row, err := s.q.InsertOffer(ctx, creditdb.InsertOfferParams{
		ID: id, UserID: p.UserID, PrincipalMinor: amount.Amount(), TenorDays: int32(tenorDays), //nolint:gosec // a key of aprByTenor
		AprBps: int32(terms.AprBps), InterestMinor: terms.Interest.Amount(), FeeMinor: terms.Fee.Amount(), //nolint:gosec // a value of aprByTenor
		StartDate: lagosDay(now), ExpiresAt: now.Add(offerTTL), CreatedAt: now,
	})
	if err != nil {
		return Offer{}, fmt.Errorf("insert offer: %w", err)
	}
	return offerView(row), nil
}

func offerTerms(o creditdb.LoanOffer) Terms {
	return Terms{
		Principal: naira(o.PrincipalMinor), Interest: naira(o.InterestMinor), Fee: naira(o.FeeMinor),
		Total:  naira(o.PrincipalMinor + o.InterestMinor + o.FeeMinor),
		AprBps: int(o.AprBps), TenorDays: int(o.TenorDays),
	}
}

func offerView(o creditdb.LoanOffer) Offer {
	terms := offerTerms(o)
	items := plan(terms.Total.Amount(), terms.TenorDays, o.StartDate)
	sched := make([]Installment, len(items))
	for i, it := range items {
		sched[i] = Installment{Number: it.Number, Due: it.Due, Amount: naira(it.Amount), Paid: naira(0), Status: "upcoming"}
	}
	return Offer{ID: o.ID, Terms: terms, Schedule: sched, ExpiresAt: o.ExpiresAt}
}

// ---- loans ----------------------------------------------------------------------------------

// Loan is a loan with its schedule (contract Loan).
type Loan struct {
	ID          uuid.UUID
	Principal   money.Money
	Outstanding money.Money
	AprBps      int
	TenorDays   int
	Status      string
	AutoRepay   bool
	Schedule    []Installment
	DisbursedAt time.Time
	NextDue     *Installment
	// Payoff is what clears the loan today (CRD-4); nil once repaid.
	Payoff *money.Money
}

// payoff is the unused-interest rebate for paying off today. The loan's interest is spread
// over its tenor; the days not yet used are given back, rounded up in the customer's favour,
// but never more than the interest still inside what they owe.
func payoff(l creditdb.Loan, owed int64, today time.Time) int64 {
	if owed <= 0 || l.InterestMinor == 0 {
		return 0
	}
	used := int64(today.Sub(l.StartDate) / (24 * time.Hour))
	left := max(0, int64(l.TenorDays)-max(0, used))
	rebate := (l.InterestMinor*left + int64(l.TenorDays) - 1) / int64(l.TenorDays)
	inside := owed * l.InterestMinor / l.TotalMinor // interest share of the remaining debt, rounded down
	return min(rebate, inside)
}

func (s *Service) view(l creditdb.Loan, balanceMinor int64, items []creditdb.LoanInstallment) Loan {
	today := lagosDay(s.now())
	owed := max(0, -balanceMinor)
	out := Loan{
		ID: l.ID, Principal: naira(l.PrincipalMinor), Outstanding: naira(owed), AprBps: int(l.AprBps), TenorDays: int(l.TenorDays),
		AutoRepay: l.AutoRepay, DisbursedAt: l.DisbursedAt, Schedule: make([]Installment, len(items)),
	}
	overdue := false
	for i, it := range items {
		st := installmentStatus(it.AmountMinor, it.PaidMinor, it.DueDate, today)
		out.Schedule[i] = Installment{Number: int(it.Number), Due: it.DueDate, Amount: naira(it.AmountMinor), Paid: naira(it.PaidMinor), Status: st}
		overdue = overdue || st == "overdue"
		if out.NextDue == nil && st != "paid" {
			out.NextDue = &out.Schedule[i]
		}
	}
	switch {
	case l.Status == "repaid":
		out.Status = "repaid"
	case l.Status == "defaulted":
		out.Status = "defaulted"
	case overdue:
		out.Status = "overdue"
	default:
		out.Status = "active"
	}
	if owed > 0 {
		p := naira(owed - payoff(l, owed, today))
		out.Payoff = &p
	}
	return out
}

// Accept turns an offer into a loan (CRD-3): the principal is paid into the customer's
// naira account, the debt is booked on the loan's own account and the schedule is made.
// Accepting the same offer again returns the loan it already made.
func (s *Service) Accept(ctx context.Context, offerID, into uuid.UUID, autoRepay bool) (Loan, error) {
	p, err := principal(ctx)
	if err != nil {
		return Loan{}, err
	}
	profile, err := s.customers.CustomerProfile(ctx, p.UserID)
	if err != nil {
		return Loan{}, err
	}
	if profile.KycTier < minTier {
		return Loan{}, errTier
	}
	acc, err := s.accounts.Owned(ctx, p.UserID, into)
	if err != nil {
		return Loan{}, err
	}
	switch {
	case acc.Status != "active":
		return Loan{}, errNotActive
	case acc.Currency != string(money.NGN):
		return Loan{}, errNaira
	}
	now := s.now().UTC()
	var loanID uuid.UUID
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := creditdb.New(tx)
		offer, err := q.LockOffer(ctx, creditdb.LockOfferParams{ID: offerID, UserID: p.UserID})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrOfferNotFound
		}
		if err != nil {
			return fmt.Errorf("lock offer: %w", err)
		}
		if done, err := q.GetLoanByOffer(ctx, creditdb.GetLoanByOfferParams{OfferID: offerID, UserID: p.UserID}); err == nil {
			loanID = done.ID // a retry: the loan already exists
			return nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("find loan: %w", err)
		}
		if now.After(offer.ExpiresAt) {
			return errExpired
		}
		// Eligibility is checked again at the moment of lending: the customer may have
		// borrowed elsewhere, or their salary may have stopped, since the offer was priced.
		el, err := s.eligibility(ctx, q, p.UserID)
		if err != nil {
			return err
		}
		if !el.Eligible {
			return errNotEligible
		}
		if offer.PrincipalMinor > el.Max.Amount() {
			return errTooMuch
		}
		id, err := uuid.NewV7()
		if err != nil {
			return fmt.Errorf("loan id: %w", err)
		}
		terms := offerTerms(offer)
		account, err := ledger.OpenCustomerAccount(ctx, tx, p.UserID, "customer_loan", string(money.NGN), "Nem Credit loan")
		if err != nil {
			return err
		}
		interestAcc, err := systemAccount(ctx, tx, "interest_income")
		if err != nil {
			return err
		}
		feeAcc, err := systemAccount(ctx, tx, "fee_income")
		if err != nil {
			return err
		}
		// The debt (principal + interest + fee) is booked on the loan account; the customer
		// gets the principal and the bank books the interest and the fee as income.
		ref := reference("LON", id)
		posted, err := ledger.Post(ctx, tx, ledger.Entry{
			Kind: "loan_disbursement", Reference: ref, IdempotencyKey: "loan:" + offer.ID.String(),
			Metadata: map[string]any{"loan_id": id.String(), "tenor_days": terms.TenorDays},
			Legs: []ledger.Leg{
				ledger.Debit(account, terms.Total), ledger.Credit(acc.AccountID, terms.Principal),
				ledger.Credit(interestAcc, terms.Interest), ledger.Credit(feeAcc, terms.Fee),
			},
		})
		if err != nil {
			return err
		}
		if _, err := accounts.Record(ctx, tx, accounts.Line{
			UserID: p.UserID, AccountID: acc.AccountID, Type: "loan_disbursement", Direction: "credit", Status: "completed",
			Amount: terms.Principal, Entry: &posted, Narration: "Nem Credit loan", Reference: ref, Category: "other",
			Counterparty: api.Counterparty{Name: "Nem Credit"}, At: now,
		}); err != nil {
			return err
		}
		loan, err := q.InsertLoan(ctx, creditdb.InsertLoanParams{
			ID: id, UserID: p.UserID, OfferID: offer.ID, AccountID: account, RepaymentAccountID: acc.AccountID,
			PrincipalMinor: offer.PrincipalMinor, AprBps: offer.AprBps, TenorDays: offer.TenorDays, InterestMinor: offer.InterestMinor,
			FeeMinor: offer.FeeMinor, TotalMinor: terms.Total.Amount(), StartDate: offer.StartDate, AutoRepay: autoRepay, DisbursedAt: now,
		})
		if err != nil {
			if isUnique(err) {
				return errOpenLoan // loans_one_open: a racing accept won
			}
			return fmt.Errorf("insert loan: %w", err)
		}
		for _, it := range plan(terms.Total.Amount(), terms.TenorDays, offer.StartDate) {
			if err := q.InsertInstallment(ctx, creditdb.InsertInstallmentParams{
				LoanID: loan.ID, Number: int32(it.Number), DueDate: it.Due, AmountMinor: it.Amount, //nolint:gosec // a handful of instalments
			}); err != nil {
				return fmt.Errorf("insert installment: %w", err)
			}
		}
		loanID = loan.ID
		return emit(ctx, tx, TopicDisbursed, loan.ID, map[string]any{
			"user_id": p.UserID, "loan_id": loan.ID, "principal_minor": loan.PrincipalMinor, "total_minor": loan.TotalMinor,
		})
	})
	if err != nil {
		return Loan{}, err
	}
	return s.Loan(ctx, loanID)
}

// systemAccount is a bank income account.
func systemAccount(ctx context.Context, tx pgx.Tx, kind string) (uuid.UUID, error) {
	acc, err := ledger.SystemAccount(ctx, tx, kind, string(money.NGN))
	if err != nil {
		return uuid.Nil, fmt.Errorf("%s account: %w", kind, err)
	}
	return acc.ID, nil
}

// Loan reads one of the caller's loans with its schedule.
func (s *Service) Loan(ctx context.Context, id uuid.UUID) (Loan, error) {
	p, err := principal(ctx)
	if err != nil {
		return Loan{}, err
	}
	return s.load(ctx, s.q, p.UserID, id)
}

func (s *Service) load(ctx context.Context, q *creditdb.Queries, userID, id uuid.UUID) (Loan, error) {
	row, err := q.GetLoan(ctx, creditdb.GetLoanParams{ID: id, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Loan{}, ErrLoanNotFound
	}
	if err != nil {
		return Loan{}, fmt.Errorf("load loan: %w", err)
	}
	items, err := q.ListInstallments(ctx, id)
	if err != nil {
		return Loan{}, fmt.Errorf("load schedule: %w", err)
	}
	return s.view(row.Loan, row.BalanceMinor, items), nil
}

// Loans lists the caller's loans, open ones first.
func (s *Service) Loans(ctx context.Context) ([]Loan, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListLoans(ctx, p.UserID)
	if err != nil {
		return nil, fmt.Errorf("list loans: %w", err)
	}
	ids := make([]uuid.UUID, len(rows))
	for i, r := range rows {
		ids[i] = r.Loan.ID
	}
	all, err := s.q.ListInstallmentsForLoans(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("list schedules: %w", err)
	}
	byLoan := make(map[uuid.UUID][]creditdb.LoanInstallment, len(rows))
	for _, it := range all {
		byLoan[it.LoanID] = append(byLoan[it.LoanID], it)
	}
	out := make([]Loan, len(rows))
	for i, r := range rows {
		out[i] = s.view(r.Loan, r.BalanceMinor, byLoan[r.Loan.ID])
	}
	return out, nil
}

// SetAutoRepay turns auto-repay on or off.
func (s *Service) SetAutoRepay(ctx context.Context, id uuid.UUID, on bool) (Loan, error) {
	p, err := principal(ctx)
	if err != nil {
		return Loan{}, err
	}
	if _, err := s.load(ctx, s.q, p.UserID, id); err != nil {
		return Loan{}, err
	}
	if err := s.q.SetLoanAutoRepay(ctx, creditdb.SetLoanAutoRepayParams{ID: id, AutoRepay: on}); err != nil {
		return Loan{}, fmt.Errorf("set auto-repay: %w", err)
	}
	return s.Loan(ctx, id)
}

// Repay pays part or all of a loan from one of the caller's naira accounts (CRD-4). Paying
// exactly the payoff amount closes the loan and gives back the interest for the days not
// used; paying more than is owed is refused.
func (s *Service) Repay(ctx context.Context, id, from uuid.UUID, amount money.Money) (Loan, error) {
	p, err := principal(ctx)
	if err != nil {
		return Loan{}, err
	}
	if amount.Currency() != money.NGN {
		return Loan{}, errNaira
	}
	if !amount.IsPositive() {
		return Loan{}, problem.Validation(problem.Field("/amount", "positive", "Enter an amount above zero."))
	}
	if _, err := s.load(ctx, s.q, p.UserID, id); err != nil {
		return Loan{}, err
	}
	acc, err := s.accounts.Owned(ctx, p.UserID, from)
	if err != nil {
		return Loan{}, err
	}
	switch {
	case acc.Status != "active":
		return Loan{}, errNotActive
	case acc.Currency != string(money.NGN):
		return Loan{}, errNaira
	}
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		return s.collect(ctx, tx, id, acc.AccountID, p.UserID, amount.Amount(), true, "Loan repayment")
	})
	if err != nil {
		return Loan{}, err
	}
	return s.Loan(ctx, id)
}

// collect takes up to amount from a customer account into a loan, in tx, under the loan's
// row lock. With exactPayoff, an amount equal to the payoff figure closes the loan with the
// unused-interest rebate; otherwise the amount must not exceed what is owed.
func (s *Service) collect(ctx context.Context, tx pgx.Tx, loanID, from, userID uuid.UUID, amount int64, exactPayoff bool, narration string) error {
	q := creditdb.New(tx)
	l, err := q.LockLoan(ctx, loanID)
	if err != nil {
		return fmt.Errorf("lock loan: %w", err)
	}
	if l.Status == "repaid" {
		return errRepaid
	}
	bal, err := ledger.GetBalances(ctx, tx, l.AccountID)
	if err != nil {
		return err
	}
	owed := max(0, -bal.Ledger.Amount())
	today := lagosDay(s.now())
	rebate := int64(0)
	if exactPayoff {
		if r := payoff(l, owed, today); r > 0 && amount == owed-r {
			rebate = r
		}
	}
	if amount > owed {
		return errTooMuchPaid
	}
	now := s.now().UTC()
	ref := reference("LON", uuid.New())
	legs := []ledger.Leg{ledger.Debit(from, naira(amount)), ledger.Credit(l.AccountID, naira(amount+rebate))}
	if rebate > 0 {
		interestAcc, err := systemAccount(ctx, tx, "interest_income")
		if err != nil {
			return err
		}
		legs = append(legs, ledger.Debit(interestAcc, naira(rebate)))
	}
	posted, err := ledger.Post(ctx, tx, ledger.Entry{
		Kind: "loan_repayment", Reference: ref, Metadata: map[string]any{"loan_id": l.ID.String(), "rebate_minor": rebate}, Legs: legs,
	})
	if err != nil {
		return err
	}
	if _, err := accounts.Record(ctx, tx, accounts.Line{
		UserID: userID, AccountID: from, Type: "loan_repayment", Direction: "debit", Status: "completed", Amount: naira(amount),
		Entry: &posted, Narration: narration, Reference: ref, Category: "fees_charges", Counterparty: api.Counterparty{Name: "Nem Credit"}, At: now,
	}); err != nil {
		return err
	}
	items, err := q.ListInstallments(ctx, l.ID)
	if err != nil {
		return fmt.Errorf("load schedule: %w", err)
	}
	if err := s.applyPaid(ctx, q, items, amount, owed-amount-rebate == 0); err != nil {
		return err
	}
	if owed-amount-rebate > 0 {
		return emit(ctx, tx, TopicRepayment, l.ID, map[string]any{"user_id": userID, "loan_id": l.ID, "amount_minor": amount})
	}
	if err := q.SetLoanStatus(ctx, creditdb.SetLoanStatusParams{ID: l.ID, Status: "repaid", ClosedAt: &now, RebateMinor: rebate}); err != nil {
		return fmt.Errorf("close loan: %w", err)
	}
	return emit(ctx, tx, TopicRepaid, l.ID, map[string]any{"user_id": userID, "loan_id": l.ID, "rebate_minor": rebate})
}

// applyPaid spreads a payment over the instalments, oldest first. When the loan is cleared
// every instalment is marked fully paid (a payoff rebate means the amounts paid add up to
// less than the instalments did).
func (s *Service) applyPaid(ctx context.Context, q *creditdb.Queries, items []creditdb.LoanInstallment, amount int64, cleared bool) error {
	for _, it := range items {
		take := min(amount, it.AmountMinor-it.PaidMinor)
		paid := it.PaidMinor + take
		if cleared {
			paid = it.AmountMinor
		}
		if paid == it.PaidMinor {
			continue
		}
		amount -= take
		if err := q.SetInstallmentPaid(ctx, creditdb.SetInstallmentPaidParams{LoanID: it.LoanID, Number: it.Number, PaidMinor: paid}); err != nil {
			return fmt.Errorf("pay installment: %w", err)
		}
	}
	return nil
}
