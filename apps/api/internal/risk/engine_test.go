package risk

import (
	"encoding/json"
	"math"
	"os"
	"testing"
	"time"
)

type goldenFile struct {
	Tolerance float64 `json:"tolerance"`
	Cases     []struct {
		Features map[string]*float64 `json:"features"`
		Score    float64             `json:"score"`
	} `json:"cases"`
}

func featuresFrom(m map[string]*float64) []float64 {
	out := make([]float64, len(featureNames))
	for i, n := range featureNames {
		if v := m[n]; v != nil {
			out[i] = *v
		} else {
			out[i] = math.NaN()
		}
	}
	return out
}

// TestModelMatchesPython is the parity gate: Go (leaves) must give the probabilities the
// Python training run recorded for 50 cases, including ones with unknown values.
func TestModelMatchesPython(t *testing.T) {
	e, err := New()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("model/golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g goldenFile
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Cases) < 50 {
		t.Fatalf("golden has %d cases, want 50", len(g.Cases))
	}
	for i, c := range g.Cases {
		got := e.model.PredictSingle(featuresFrom(c.Features), 0)
		if math.Abs(got-c.Score) > g.Tolerance {
			t.Errorf("case %d: go %.8f, python %.8f", i, got, c.Score)
		}
	}
}

func calm() Features {
	return Features{
		AmountNGN: 5_000, LogAmount: math.Log1p(5_000), AmountZScore: 0.2, AmountToBalance: 0.05,
		Velocity1h: 0, Velocity24h: 1, NewBeneficiary: 0, NewDevice: 0, HourOfDay: 14,
		AccountAgeDays: 400, PriorCount: 60,
	}
}

func TestCalmTransferIsAllowed(t *testing.T) {
	e, _ := New()
	a := e.Assess(calm())
	if a.Decision != Allow || len(a.Reasons) != 0 || !a.ModelUsed {
		t.Fatalf("got %+v", a)
	}
}

func TestAccountTakeoverPatternIsHeldWithReasons(t *testing.T) {
	e, _ := New()
	f := calm()
	f.AmountNGN, f.LogAmount = 400_000, math.Log1p(400_000)
	f.AmountZScore, f.AmountToBalance = 6, 0.9
	f.NewBeneficiary, f.NewDevice, f.HourOfDay = 1, 1, 2
	f.Velocity1h = 4
	a := e.Assess(f)
	if a.Decision != Hold {
		t.Fatalf("decision %s, want hold: %+v", a.Decision, a)
	}
	codes := map[string]bool{}
	for _, r := range a.Reasons {
		codes[r.Code] = true
	}
	for _, want := range []string{"velocity_burst", "unusual_amount", "drains_balance", "new_device", "night_large"} {
		if !codes[want] {
			t.Errorf("missing reason %s in %+v", want, a.Reasons)
		}
	}
}

func TestRulesOnlyIsTheFallback(t *testing.T) {
	e := RulesOnly()
	if e.ModelLoaded() {
		t.Fatal("rules-only engine has a model")
	}
	f := calm()
	if a := e.Assess(f); a.Decision != Allow || a.ModelUsed {
		t.Fatalf("calm: %+v", a)
	}
	// 30 + 25 + 25 + 20 + 20 + 20 = 140 points: past the hold line.
	f.Velocity1h, f.AmountZScore, f.AmountToBalance = 4, 5, 0.8
	f.NewBeneficiary, f.NewDevice, f.AmountNGN, f.AccountAgeDays = 1, 1, 80_000, 10
	a := e.Assess(f)
	if a.Decision != Hold || a.ModelUsed || a.ModelVersion != "rules-v1" {
		t.Fatalf("risky: %+v", a)
	}
	// Exactly step-up: 30 + 20 = 50 points.
	g := calm()
	g.Velocity1h, g.NewDevice = 4, 1
	if a := e.Assess(g); a.Decision != StepUp {
		t.Fatalf("step-up: %+v", a)
	}
}

func TestUnknownValuesScoreNothing(t *testing.T) {
	f := calm()
	f.AmountZScore, f.NewDevice, f.AccountAgeDays = math.NaN(), math.NaN(), math.NaN()
	if _, pts := fired(f); pts != 0 {
		t.Fatalf("unknown values fired %d points", pts)
	}
	if _, err := json.Marshal(f); err != nil {
		t.Fatalf("features with NaN must marshal: %v", err)
	}
}

func TestRulesMatchPythonTable(t *testing.T) {
	if maxPoints != 185 {
		t.Fatalf("max points %d, the Python baseline has 185", maxPoints)
	}
	if rulesStepUpPoints != 50 || rulesHoldPoints != 105 {
		t.Fatal("rule thresholds drifted from the model card (50/185, 105/185)")
	}
}

// TestAssessIsFast holds the 10 ms budget with a wide margin for slow CI machines.
func TestAssessIsFast(t *testing.T) {
	e, _ := New()
	f := calm()
	var worst time.Duration
	for range 2000 {
		if d := e.Assess(f).Duration; d > worst {
			worst = d
		}
	}
	if worst > 10*time.Millisecond {
		t.Fatalf("slowest assessment took %s, budget is 10ms", worst)
	}
}

func BenchmarkAssess(b *testing.B) {
	e, err := New()
	if err != nil {
		b.Fatal(err)
	}
	f := calm()
	b.ResetTimer()
	for range b.N {
		e.Assess(f)
	}
}
