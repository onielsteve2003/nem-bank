// Package risk scores every outgoing transfer before it is sent (AI-1). Hand-written rules
// and a LightGBM model trained in Python (ml/) run together; the model is scored in pure Go
// with leaves, so there is no Python service in production. The answer is allow, step_up
// (ask for more proof) or hold (wait for staff), with reason codes the customer can read.
//
// If the model cannot load, the rules alone decide: that is the non-AI fallback.
package risk

import (
	"bufio"
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/dmitryikh/leaves"
)

//go:embed model/model.txt model/export.json
var modelFS embed.FS

// Decision is what the engine says to do with a transfer (contract RiskDecision).
type Decision string

// The decisions, mildest first.
const (
	Allow  Decision = "allow"
	StepUp Decision = "step_up"
	Hold   Decision = "hold"
)

// Features are what the model sees for one transfer. Each is computed from the customer's
// earlier activity only, exactly as ml/src/nemml/features.py does. NaN means unknown.
type Features struct {
	AmountNGN       float64 // not a model input; the rules use it
	LogAmount       float64
	AmountZScore    float64 // NaN until five earlier transfers exist
	AmountToBalance float64
	Velocity1h      float64
	Velocity24h     float64
	NewBeneficiary  float64
	NewDevice       float64 // NaN when the device is unknown
	HourOfDay       float64
	AccountAgeDays  float64 // NaN when unknown
	PriorCount      float64
}

// featureNames is the model's input order; New refuses a model exported with another.
var featureNames = []string{
	"log_amount", "amount_zscore", "amount_to_balance", "velocity_1h", "velocity_24h",
	"new_beneficiary", "new_device", "hour_of_day", "account_age_days", "prior_count",
}

// Vector is f in the model's input order.
func (f Features) Vector() []float64 {
	return []float64{
		f.LogAmount, f.AmountZScore, f.AmountToBalance, f.Velocity1h, f.Velocity24h,
		f.NewBeneficiary, f.NewDevice, f.HourOfDay, f.AccountAgeDays, f.PriorCount,
	}
}

// MarshalJSON writes unknown (NaN) values as null, which JSON cannot otherwise hold.
func (f Features) MarshalJSON() ([]byte, error) {
	vals := map[string]float64{
		"amount_ngn": f.AmountNGN, "log_amount": f.LogAmount, "amount_zscore": f.AmountZScore,
		"amount_to_balance": f.AmountToBalance, "velocity_1h": f.Velocity1h, "velocity_24h": f.Velocity24h,
		"new_beneficiary": f.NewBeneficiary, "new_device": f.NewDevice, "hour_of_day": f.HourOfDay,
		"account_age_days": f.AccountAgeDays, "prior_count": f.PriorCount,
	}
	m := make(map[string]*float64, len(vals))
	for k, v := range vals {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			m[k] = nil
			continue
		}
		m[k] = &v
	}
	return json.Marshal(m)
}

type exportMeta struct {
	Model      string   `json:"model"`
	Features   []string `json:"features"`
	Thresholds struct {
		StepUp float64 `json:"step_up"`
		Hold   float64 `json:"hold"`
	} `json:"thresholds"`
}

// Engine scores features. It is safe for concurrent use.
type Engine struct {
	model        *leaves.Ensemble // nil: rules only
	version      string
	stepUp, hold float64
}

// Reason is one explained part of a decision (contract RiskReason).
type Reason struct {
	Code     string `json:"code"`
	Message  string `json:"message"`
	Severity string `json:"severity"`
}

// Assessment is the engine's answer for one transfer.
type Assessment struct {
	Decision Decision
	// Score is the model's probability of fraud, or the rules score when the model is not used.
	Score float64
	// RulesScore is the rules' points over the most they could give, 0 to 1.
	RulesScore   float64
	Reasons      []Reason
	ModelVersion string
	ModelUsed    bool
	Duration     time.Duration
}

// New loads the embedded model. A model that will not load is an error; use RulesOnly to
// run without one on purpose.
func New() (*Engine, error) {
	metaRaw, err := modelFS.ReadFile("model/export.json")
	if err != nil {
		return nil, fmt.Errorf("risk: read export: %w", err)
	}
	var meta exportMeta
	if err := json.Unmarshal(metaRaw, &meta); err != nil {
		return nil, fmt.Errorf("risk: parse export: %w", err)
	}
	if len(meta.Features) != len(featureNames) {
		return nil, errors.New("risk: model features do not match the engine")
	}
	for i, n := range featureNames {
		if meta.Features[i] != n {
			return nil, fmt.Errorf("risk: model feature %d is %q, engine expects %q", i, meta.Features[i], n)
		}
	}
	if meta.Thresholds.StepUp <= 0 || meta.Thresholds.StepUp >= meta.Thresholds.Hold || meta.Thresholds.Hold >= 1 {
		return nil, errors.New("risk: model thresholds are not 0 < step_up < hold < 1")
	}
	raw, err := modelFS.ReadFile("model/model.txt")
	if err != nil {
		return nil, fmt.Errorf("risk: read model: %w", err)
	}
	m, err := leaves.LGEnsembleFromReader(bufio.NewReader(bytes.NewReader(raw)), true)
	if err != nil {
		return nil, fmt.Errorf("risk: load model: %w", err)
	}
	if m.NFeatures() != len(featureNames) {
		return nil, fmt.Errorf("risk: model takes %d features, engine has %d", m.NFeatures(), len(featureNames))
	}
	return &Engine{model: m, version: meta.Model, stepUp: meta.Thresholds.StepUp, hold: meta.Thresholds.Hold}, nil
}

// RulesOnly is the non-AI engine: the hand-written rules decide alone.
func RulesOnly() *Engine { return &Engine{version: "rules-v1"} }

// ModelLoaded reports whether the model is in use.
func (e *Engine) ModelLoaded() bool { return e.model != nil }

// Assess scores one transfer. It does no I/O; the budget is 10 ms and it takes microseconds.
func (e *Engine) Assess(f Features) Assessment {
	start := time.Now()
	hits, points := fired(f)
	rulesScore := float64(points) / float64(maxPoints)
	rulesDecision := Allow
	switch {
	case points >= rulesHoldPoints:
		rulesDecision = Hold
	case points >= rulesStepUpPoints:
		rulesDecision = StepUp
	}

	a := Assessment{Decision: rulesDecision, Score: rulesScore, RulesScore: rulesScore, ModelVersion: e.version}
	if e.model != nil {
		// A model that returns nonsense must not decide money: the rules decide instead.
		if p := e.model.PredictSingle(f.Vector(), 0); p >= 0 && p <= 1 {
			a.ModelUsed, a.Score = true, p
			switch {
			case p >= e.hold:
				a.Decision = Hold
			case p >= e.stepUp:
				a.Decision = StepUp
			default:
				a.Decision = Allow
			}
			// Rules that are sure on their own are never overruled by a quiet model.
			if rulesDecision == Hold {
				a.Decision = Hold
			}
		}
	}
	for _, r := range hits {
		a.Reasons = append(a.Reasons, Reason{Code: r.Code, Message: r.Message, Severity: r.Severity})
	}
	if a.Decision != Allow && len(a.Reasons) == 0 {
		// The model sees a pattern no single rule names.
		a.Reasons = append(a.Reasons, Reason{
			Code: "unusual_pattern", Severity: "medium",
			Message: "This payment looks different from how you normally pay.",
		})
	}
	if a.Reasons == nil {
		a.Reasons = []Reason{}
	}
	a.Duration = time.Since(start)
	return a
}
