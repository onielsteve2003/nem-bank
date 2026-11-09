// Package limits is the limits and fees engine (T25.5): the KYC tier caps, the customer's
// own limits (SEC-3), the daily rollup every outgoing transfer is counted against, and
// the demo fee schedule with the Electronic Money Transfer Levy (TRF-4).
//
// The numbers are demo values based on public CBN guidance, the same as the mock bank's
// (packages/shared/src/constants.ts). They live in Rules so staff configuration (ADM-8)
// can replace them without touching the engine.
package limits

import (
	"time"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

// Tier is one KYC tier's caps, in kobo.
type Tier struct {
	DailyMinor int64
	// MaxBalanceMinor caps the NGN balance; 0 means no cap.
	MaxBalanceMinor int64
}

// FeeBand charges FeeMinor on amounts up to UpToMinor; UpToMinor 0 is the open-ended last band.
type FeeBand struct {
	UpToMinor, FeeMinor int64
}

// Rules are the configurable numbers.
type Rules struct {
	Tiers map[int]Tier
	// ExternalBands price transfers to other banks; the first band covering the amount
	// applies. Nem to Nem is free.
	ExternalBands []FeeBand
	// EMTLThresholdMinor and EMTLMinor: the levy on naira inflows of the threshold or more.
	EMTLThresholdMinor, EMTLMinor int64
	// IncreaseDelay is how long a raised self-set limit waits before it applies.
	IncreaseDelay time.Duration
	// New-beneficiary cooling-off (TRF-8): for BeneficiaryCoolingOff after it is saved (and
	// for any account never saved), a first transfer above CoolingOffThresholdMinor waits
	// CoolingOffDelay unless the customer steps up.
	CoolingOffThresholdMinor               int64
	CoolingOffDelay, BeneficiaryCoolingOff time.Duration
}

// naira is n naira in kobo.
func naira(n int64) int64 { return n * 100 }

// DefaultRules are PRD FR-KYC and TRF-4's demo values.
func DefaultRules() Rules {
	return Rules{
		Tiers: map[int]Tier{
			1: {DailyMinor: naira(50_000), MaxBalanceMinor: naira(300_000)},
			2: {DailyMinor: naira(200_000), MaxBalanceMinor: naira(500_000)},
			3: {DailyMinor: naira(5_000_000)},
		},
		ExternalBands: []FeeBand{
			{UpToMinor: naira(5_000), FeeMinor: naira(10)},
			{UpToMinor: naira(50_000), FeeMinor: naira(25)},
			{FeeMinor: naira(50)},
		},
		EMTLThresholdMinor: naira(10_000),
		EMTLMinor:          naira(50),
		IncreaseDelay:      24 * time.Hour,

		CoolingOffThresholdMinor: naira(100_000),
		CoolingOffDelay:          30 * time.Minute,
		BeneficiaryCoolingOff:    24 * time.Hour,
	}
}

// Tier returns tier's caps; an unknown tier gets Tier 1's, the strictest.
func (r Rules) Tier(tier int) Tier {
	if t, ok := r.Tiers[tier]; ok {
		return t
	}
	return r.Tiers[1]
}

// TransferFee is the sender's fee for amount on a rail ("internal" or "interbank").
func (r Rules) TransferFee(amount money.Money, rail string) money.Money {
	if rail == "internal" {
		return money.New(0, amount.Currency())
	}
	for _, b := range r.ExternalBands {
		if b.UpToMinor == 0 || amount.Amount() <= b.UpToMinor {
			return money.New(b.FeeMinor, amount.Currency())
		}
	}
	return money.New(0, amount.Currency())
}

// EMTL is the levy on a naira inflow: charged to the receiver, paid to the government.
func (r Rules) EMTL(inflow money.Money) money.Money {
	if inflow.Currency() == money.NGN && inflow.Amount() >= r.EMTLThresholdMinor {
		return money.New(r.EMTLMinor, money.NGN)
	}
	return money.New(0, inflow.Currency())
}

// wat is Lagos time (UTC+1, no daylight saving): daily limits reset at Lagos midnight.
var wat = time.FixedZone("WAT", 3600)

// Day is the Lagos calendar day of t, as a UTC midnight for a SQL date.
func Day(t time.Time) time.Time {
	y, m, d := t.In(wat).Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}
