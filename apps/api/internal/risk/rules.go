package risk

import "math"

// Rule is one hand-written risk signal. The table mirrors ml/src/nemml/rules.py exactly (same
// codes, same points), so the Python baseline and the Go fallback are the same rules.
type Rule struct {
	Code     string
	Points   int
	Severity string // contract RiskReason severity: low, medium or high
	// Message is what the customer sees, in plain language.
	Message string
	fires   func(Features) bool
}

// A NaN feature compares false, so an unknown value scores nothing (as in Python).
func gt(v, x float64) bool { return !math.IsNaN(v) && v > x }
func lt(v, x float64) bool { return !math.IsNaN(v) && v < x }

// Rules are the risk rules, in the order they are reported.
var Rules = []Rule{
	{"velocity_burst", 30, "high", "Several payments in a short time.",
		func(f Features) bool { return gt(f.Velocity1h, 2) }},
	{"velocity_day", 15, "medium", "A lot of payments in one day.",
		func(f Features) bool { return gt(f.Velocity24h, 14) }},
	{"unusual_amount", 25, "high", "This is far more than you usually send.",
		func(f Features) bool { return gt(f.AmountZScore, 3) }},
	{"drains_balance", 25, "high", "This moves most of your balance.",
		func(f Features) bool { return gt(f.AmountToBalance, 0.5) }},
	{"new_beneficiary_large", 20, "medium", "First payment to this person, and it is a large one.",
		func(f Features) bool { return f.NewBeneficiary == 1 && gt(f.AmountNGN, 50_000) }},
	{"new_beneficiary_young_account", 20, "medium", "First payment to this person from a new account.",
		func(f Features) bool { return f.NewBeneficiary == 1 && lt(f.AccountAgeDays, 90) }},
	{"new_device", 20, "medium", "First payment from this device.",
		func(f Features) bool { return f.NewDevice == 1 }},
	{"night_large", 15, "low", "A large payment in the middle of the night.",
		func(f Features) bool { return lt(f.HourOfDay, 5) && gt(f.AmountNGN, 50_000) }},
	{"young_account", 15, "low", "Your account is new and this is a sizeable payment.",
		func(f Features) bool { return lt(f.AccountAgeDays, 30) && gt(f.AmountNGN, 10_000) }},
}

// maxPoints is every rule firing at once; rules scores are points / maxPoints, which is how
// the Python baseline's thresholds (0.27027 and 0.567568) were set.
var maxPoints = func() int {
	n := 0
	for _, r := range Rules {
		n += r.Points
	}
	return n
}()

// Rule decision thresholds, in points (50/185 and 105/185 in the model card).
const (
	rulesStepUpPoints = 50
	rulesHoldPoints   = 105
)

// fired returns the rules that fire for f and their total points.
func fired(f Features) ([]Rule, int) {
	var out []Rule
	pts := 0
	for _, r := range Rules {
		if r.fires(f) {
			out = append(out, r)
			pts += r.Points
		}
	}
	return out, pts
}
