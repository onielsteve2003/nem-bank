package credit

import (
	"context"
	_ "embed" // the model file is embedded
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"sort"
)

// The trained model: logistic regression on five standardized features, produced by
// `uv run nemml credit` in ml/ (see model_card.md there). golden.json holds Python's answers,
// which model_test.go reproduces.
//
//go:embed model/model.json
var modelJSON []byte

type modelFeature struct {
	Name   string  `json:"name"`
	Mean   float64 `json:"mean"`
	Scale  float64 `json:"scale"`
	Weight float64 `json:"weight"`
}

type modelBand struct {
	Band  string  `json:"band"`
	Below float64 `json:"below"`
}

type modelFile struct {
	Model     string         `json:"model"`
	Features  []modelFeature `json:"features"`
	Intercept float64        `json:"intercept"`
	Bands     []modelBand    `json:"bands"`
	ShareBps  map[string]int `json:"share_bps"`
}

// ModelScorer scores with the trained model. It is safe for concurrent use.
type ModelScorer struct{ m modelFile }

// minReasonShift is how far a feature must move the default log-odds to be worth telling
// the customer about.
const minReasonShift = 0.15

// NewModelScorer loads the embedded model.
func NewModelScorer() (*ModelScorer, error) {
	var m modelFile
	if err := json.Unmarshal(modelJSON, &m); err != nil {
		return nil, fmt.Errorf("credit model: %w", err)
	}
	want := []string{"log_salary", "log_age", "goals", "repaid", "defaulted"}
	if len(m.Features) != len(want) || len(m.Bands) == 0 {
		return nil, errors.New("credit model: unexpected shape")
	}
	for i, f := range m.Features {
		if f.Name != want[i] || f.Scale == 0 {
			return nil, fmt.Errorf("credit model: feature %d is %q", i, f.Name)
		}
	}
	return &ModelScorer{m: m}, nil
}

// inputs is transform() in ml/src/nemml/credit.py: same clamps, same logs.
func inputs(f Facts) []float64 {
	clamp := func(v, hi int) float64 { return float64(min(max(v, 0), hi)) }
	return []float64{
		math.Log1p(math.Max(float64(f.MonthlySalary.Amount())/100, 0)),
		math.Log1p(math.Max(float64(f.AccountAgeDays), 0)),
		clamp(f.ActiveGoals, 5),
		clamp(f.RepaidLoans, 5),
		clamp(f.DefaultedLoans, 3),
	}
}

// Probability is the chance of default and each feature's push on the log-odds (positive
// pushes toward default).
func (s *ModelScorer) Probability(f Facts) (float64, []float64) {
	x := inputs(f)
	z := s.m.Intercept
	shifts := make([]float64, len(x))
	for i, ft := range s.m.Features {
		shifts[i] = ft.Weight * (x[i] - ft.Mean) / ft.Scale
		z += shifts[i]
	}
	return 1 / (1 + math.Exp(-z)), shifts
}

func (s *ModelScorer) band(p float64) string {
	for _, b := range s.m.Bands {
		if p < b.Below {
			return b.Band
		}
	}
	return "poor"
}

// Score implements Scorer.
func (s *ModelScorer) Score(_ context.Context, f Facts) (Assessment, error) {
	p, shifts := s.Probability(f)
	band := s.band(p)

	salary := f.MonthlySalary.Amount()
	limit := salary * int64(s.m.ShareBps[band]) / 10_000
	limit = min(limit/loanStep*loanStep, maxLoan)
	if salary <= 0 {
		limit, band = 0, "poor"
	}
	return Assessment{
		Band: band, Max: naira(limit), Reasons: s.reasons(f, shifts),
		Meta: Meta{
			ModelVersion: s.m.Model,
			Explanation:  "A small statistical model weighs your salary, account age, savings habit and repayment history to estimate how likely a loan is to be repaid. It never looks at who you are.",
		},
	}, nil
}

// reasons turns the biggest feature shifts into customer wording, strongest first.
func (s *ModelScorer) reasons(f Facts, shifts []float64) []Reason {
	type item struct {
		r Reason
		w float64
	}
	var items []item
	add := func(i int, code, impact, message string) {
		items = append(items, item{Reason{Code: code, Impact: impact, Message: message}, math.Abs(shifts[i])})
	}
	const salary, age, goals, repaid, defaulted = 0, 1, 2, 3, 4
	if d := shifts[salary]; math.Abs(d) >= minReasonShift || f.MonthlySalary.Amount() == 0 {
		switch {
		case f.MonthlySalary.Amount() == 0:
			add(salary, "no_salary", "negative", "We could not see a regular income yet.")
		case d < 0:
			add(salary, "regular_salary", "positive", "Your salary arrives on time every month.")
		default:
			add(salary, "low_income", "negative", "Your regular income is lower than most borrowers have.")
		}
	}
	if d := shifts[age]; d >= minReasonShift {
		add(age, "low_account_age", "negative", "Your account is new, so you can borrow less for now.")
	} else if d <= -minReasonShift {
		add(age, "established_account", "positive", "You have had your account for a good while.")
	}
	if d := shifts[goals]; d <= -minReasonShift {
		add(goals, "savings_habit", "positive", "You save regularly.")
	} else if d >= minReasonShift {
		add(goals, "no_savings_habit", "negative", "Saving towards a goal would help your score.")
	}
	if shifts[repaid] <= -minReasonShift && f.DefaultedLoans == 0 {
		add(repaid, "repayment_history", "positive", "You have repaid a loan in full.")
	}
	if shifts[defaulted] >= minReasonShift {
		add(defaulted, "unpaid_loan_history", "negative", "A past loan was not repaid.")
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].w > items[j].w })
	out := make([]Reason, 0, len(items))
	for _, it := range items {
		out = append(out, it.r)
	}
	return out
}

// WithFallback scores with Primary and, if it fails, with the rules, so a broken model never
// stops a customer from seeing an eligibility answer (AI-5).
type WithFallback struct {
	Primary Scorer
	Log     *slog.Logger
}

// Score implements Scorer.
func (w WithFallback) Score(ctx context.Context, f Facts) (Assessment, error) {
	a, err := w.Primary.Score(ctx, f)
	if err == nil {
		return a, nil
	}
	if w.Log != nil {
		w.Log.Warn("credit model failed, using rules", "error", err)
	}
	return RulesScorer{}.Score(ctx, f)
}

// DefaultScorer is the trained model with the rules behind it; if the model will not load,
// the rules alone.
func DefaultScorer(log *slog.Logger) Scorer {
	m, err := NewModelScorer()
	if err != nil {
		log.Warn("credit model unavailable, using rules", "error", err)
		return RulesScorer{}
	}
	return WithFallback{Primary: m, Log: log}
}
