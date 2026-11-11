package credit

import (
	"context"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

// Reason is one explained part of a credit decision (contract ReasonCode). Credit decisions
// always explain themselves (CRD-1, AI-5).
type Reason struct {
	Code    string
	Impact  string // positive, negative or neutral
	Message string
}

// Meta is what the AI badge shows (contract AiMeta).
type Meta struct {
	ModelVersion string
	Explanation  string
	// FallbackUsed is true when the rules scorer, not a trained model, produced the answer.
	FallbackUsed bool
}

// Facts are what the scorer may look at: aggregates about the customer's own account, never
// raw transactions or personal details, so a model (or an LLM in a later phase) cannot leak them.
type Facts struct {
	// MonthlySalary is the average salary credited per month over the last three months.
	MonthlySalary  money.Money
	AccountAgeDays int
	ActiveGoals    int
	RepaidLoans    int
	DefaultedLoans int
	OpenLoans      int
}

// Assessment is the scorer's proposal. Policy (KYC tier, one loan at a time, past default)
// is applied afterwards by the service and cannot be overridden by a scorer.
type Assessment struct {
	Band    string // poor, fair, good or excellent
	Max     money.Money
	Reasons []Reason
	Meta    Meta
}

// Scorer is the scoring call. RulesScorer is the always-available fallback (AI-5); the
// trained logistic-regression model implements the same interface in T29.6.
type Scorer interface {
	Score(ctx context.Context, f Facts) (Assessment, error)
}

// RulesScorer scores with plain rules: up to 30% of a month's salary, in ₦5,000 steps,
// capped at ₦500,000, halved for an account under 30 days old.
type RulesScorer struct{}

// newAccountDays is how old an account must be before it can borrow its full amount.
const newAccountDays = 30

// Score implements Scorer.
func (RulesScorer) Score(_ context.Context, f Facts) (Assessment, error) {
	var reasons []Reason
	add := func(code, impact, message string) {
		reasons = append(reasons, Reason{Code: code, Impact: impact, Message: message})
	}

	salary := f.MonthlySalary.Amount()
	if salary > 0 {
		add("regular_salary", "positive", "Your salary arrives on time every month.")
	} else {
		add("no_salary", "negative", "We could not see a regular income yet.")
	}
	if f.ActiveGoals > 0 {
		add("savings_habit", "positive", "You save regularly.")
	}
	if f.RepaidLoans > 0 && f.DefaultedLoans == 0 {
		add("repayment_history", "positive", "You have repaid a loan in full.")
	}
	newAccount := f.AccountAgeDays < newAccountDays
	if newAccount {
		add("low_account_age", "negative", "Your account is new, so you can borrow less for now.")
	}

	limit := salary * salaryShareBps / 10_000
	limit = limit / loanStep * loanStep
	limit = min(limit, maxLoan)
	if newAccount {
		limit = limit / 2 / loanStep * loanStep
	}

	band := "poor"
	switch {
	case f.DefaultedLoans > 0 || salary == 0:
	case salary >= 1_000_000_00 && f.RepaidLoans > 0:
		band = "excellent"
	case salary >= 500_000_00:
		band = "good"
	default:
		band = "fair"
	}
	return Assessment{
		Band: band, Max: naira(limit), Reasons: reasons,
		Meta: Meta{
			ModelVersion: "rules-1", FallbackUsed: true,
			Explanation: "Based on how regularly salary arrives, your account age, your savings habit and past repayments.",
		},
	}, nil
}
