package credit

import (
	"context"
	_ "embed" // golden cases
	"encoding/json"
	"errors"
	"math"
	"testing"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

//go:embed model/golden.json
var goldenJSON []byte

func facts(salaryNaira int64, age, goals, repaid, defaulted int) Facts {
	return Facts{
		MonthlySalary: naira(salaryNaira * 100), AccountAgeDays: age,
		ActiveGoals: goals, RepaidLoans: repaid, DefaultedLoans: defaulted,
	}
}

func TestModelMatchesPythonOnGoldenCases(t *testing.T) {
	var g struct {
		Tolerance float64 `json:"tolerance"`
		Cases     []struct {
			Salary    float64 `json:"salary"`
			AgeDays   int     `json:"age_days"`
			Goals     int     `json:"goals"`
			Repaid    int     `json:"repaid"`
			Defaulted int     `json:"defaulted"`
			P         float64 `json:"p"`
			Band      string  `json:"band"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(goldenJSON, &g); err != nil {
		t.Fatal(err)
	}
	s, err := NewModelScorer()
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Cases) < 40 {
		t.Fatalf("only %d golden cases", len(g.Cases))
	}
	for i, c := range g.Cases {
		p, _ := s.Probability(facts(int64(c.Salary), c.AgeDays, c.Goals, c.Repaid, c.Defaulted))
		if math.Abs(p-c.P) > g.Tolerance {
			t.Errorf("case %d: p = %.8f, Python says %.8f", i, p, c.P)
		}
		if got := s.band(p); got != c.Band {
			t.Errorf("case %d: band %s, Python says %s", i, got, c.Band)
		}
	}
}

func TestModelScorerLendsByBandAndExplains(t *testing.T) {
	s, err := NewModelScorer()
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	strong, _ := s.Score(ctx, facts(1_200_000, 900, 3, 4, 0))
	if strong.Band == "poor" || strong.Max.Amount() == 0 {
		t.Fatalf("strong applicant refused: %+v", strong)
	}
	if strong.Max.Amount() > maxLoan || strong.Max.Amount()%loanStep != 0 {
		t.Errorf("limit %d is not a capped ₦5,000 multiple", strong.Max.Amount())
	}
	if strong.Meta.FallbackUsed || strong.Meta.ModelVersion == "" {
		t.Errorf("meta should name the model: %+v", strong.Meta)
	}
	if !hasReason(strong, "regular_salary", "positive") {
		t.Errorf("strong applicant should hear about their salary: %+v", strong.Reasons)
	}

	none, _ := s.Score(ctx, facts(0, 5, 0, 0, 0))
	if none.Band != "poor" || none.Max.Amount() != 0 || !hasReason(none, "no_salary", "negative") {
		t.Errorf("no income: %+v", none)
	}

	fresh, _ := s.Score(ctx, facts(250_000, 3, 0, 0, 0))
	older, _ := s.Score(ctx, facts(250_000, 400, 0, 0, 0))
	if fresh.Max.Amount() > older.Max.Amount() {
		t.Errorf("a new account lent more (%d) than an old one (%d)", fresh.Max.Amount(), older.Max.Amount())
	}
	if !hasReason(fresh, "low_account_age", "negative") {
		t.Errorf("new account should be told why: %+v", fresh.Reasons)
	}

	late, _ := s.Score(ctx, facts(600_000, 500, 2, 2, 1))
	clean, _ := s.Score(ctx, facts(600_000, 500, 2, 2, 0))
	if late.Max.Amount() > clean.Max.Amount() {
		t.Errorf("a past default lent more (%d) than a clean record (%d)", late.Max.Amount(), clean.Max.Amount())
	}
}

func hasReason(a Assessment, code, impact string) bool {
	for _, r := range a.Reasons {
		if r.Code == code && r.Impact == impact {
			return true
		}
	}
	return false
}

type failing struct{}

func (failing) Score(context.Context, Facts) (Assessment, error) {
	return Assessment{}, errors.New("boom")
}

func TestFallbackUsesRulesWhenTheModelFails(t *testing.T) {
	a, err := WithFallback{Primary: failing{}}.Score(context.Background(),
		Facts{MonthlySalary: money.New(300_000_00, money.NGN), AccountAgeDays: 90})
	if err != nil {
		t.Fatal(err)
	}
	if !a.Meta.FallbackUsed || a.Max.Amount() == 0 {
		t.Errorf("expected the rules answer, got %+v", a)
	}
}
