// Package forecast is the cash-flow forecast and subscription detection (AI-4, INS-3, INS-4).
//
// Both are plain statistics that can explain themselves, not a trained model: recurrence
// detection finds charges that repeat on a rhythm, and single exponential smoothing turns
// recent daily spending into a forecast with a widening band. The pure functions in this
// package take plain values, so every number can be reproduced by hand.
package forecast

import (
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/categorize"
)

// lagos is West Africa Time (no daylight saving): days are Lagos calendar days.
var lagos = time.FixedZone("WAT", 60*60)

// Day is the Lagos calendar day containing t, as midnight UTC (what a contract Date holds).
func Day(t time.Time) time.Time {
	y, m, d := t.In(lagos).Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

func daysBetween(a, b time.Time) int { return int(b.Sub(a).Hours() / 24) }

// Frequency is how often a subscription charges.
type Frequency string

// The rhythms detection recognises.
const (
	Weekly  Frequency = "weekly"
	Monthly Frequency = "monthly"
	Yearly  Frequency = "yearly"
)

// rhythm is the range of gaps (in days) that counts as one frequency, and how many charges
// it takes before a pattern is believed. Weekly needs more charges because a week is short
// enough for two unrelated purchases to line up by chance.
type rhythm struct {
	freq     Frequency
	minGap   int
	maxGap   int
	minCount int
	step     func(time.Time) time.Time
}

var rhythms = []rhythm{
	{Weekly, 5, 9, 4, func(t time.Time) time.Time { return t.AddDate(0, 0, 7) }},
	{Monthly, 26, 35, 3, func(t time.Time) time.Time { return t.AddDate(0, 1, 0) }},
	{Yearly, 350, 380, 2, func(t time.Time) time.Time { return t.AddDate(1, 0, 0) }},
}

const (
	// regularShare is how much of the gaps must fit the rhythm, and amountShare how many
	// charges must match the usual amount: one skipped month or one price change does not
	// hide a subscription (one change in three charges still clears 60%).
	regularShare = 0.75
	amountShare  = 0.6
	// amountTolerance is how far a charge may stray from the usual amount: 10%.
	amountTolerancePct = 10
)

// Charge is one completed card or bill payment.
type Charge struct {
	ID       uuid.UUID
	Merchant string
	Currency string
	Amount   int64
	At       time.Time
	CardID   *uuid.UUID
}

// Subscription is a rhythm found in a merchant's charges.
type Subscription struct {
	ID        uuid.UUID
	Merchant  string
	Currency  string
	Amount    int64 // the latest charge: prices change, and the next one will probably match it
	Frequency Frequency
	LastAt    time.Time
	Next      time.Time // a Lagos day
	CardID    *uuid.UUID
	// Charges are the transactions the pattern was built from, so the forecast does not
	// count them twice (once in average spending, once as an upcoming charge).
	Charges []uuid.UUID

	step func(time.Time) time.Time
}

// Advance is the charge after d.
func (s Subscription) Advance(d time.Time) time.Time { return s.step(d) }

// MonthlyAmount is what the subscription costs per month, rounded half up: a weekly charge is
// 52 a year, a yearly one a twelfth.
func (s Subscription) MonthlyAmount() int64 {
	switch s.Frequency {
	case Weekly:
		return (s.Amount*52 + 6) / 12
	case Yearly:
		return (s.Amount + 6) / 12
	default:
		return s.Amount
	}
}

// subspace gives every customer's subscriptions IDs that stay the same between requests, so
// the app can key a row on the ID.
var subspace = uuid.MustParse("5f0c1d4e-7a3b-4c52-9d1e-2b6a8f3e4c10")

// Detect finds subscriptions among a customer's card and bill payments. A merchant is a
// subscription when its charges repeat on a weekly, monthly or yearly rhythm at a similar
// amount, and the latest charge is not so old that the customer has probably cancelled.
func Detect(userID uuid.UUID, charges []Charge, today time.Time) []Subscription {
	type key struct{ merchant, currency string }
	groups := map[key][]Charge{}
	for _, c := range charges {
		k := key{categorize.MerchantKey(c.Merchant), c.Currency}
		if k.merchant == "" {
			continue
		}
		groups[k] = append(groups[k], c)
	}
	var out []Subscription
	for k, g := range groups {
		if s, ok := detectOne(userID, k.merchant, g, today); ok {
			out = append(out, s)
		}
	}
	slices.SortFunc(out, func(a, b Subscription) int {
		if c := a.Next.Compare(b.Next); c != 0 {
			return c
		}
		return strings.Compare(a.Merchant, b.Merchant)
	})
	return out
}

func detectOne(userID uuid.UUID, merchantKey string, g []Charge, today time.Time) (Subscription, bool) {
	slices.SortFunc(g, func(a, b Charge) int { return a.At.Compare(b.At) })
	// Two charges on one day are a retry or a split payment, not a rhythm.
	days := make([]time.Time, 0, len(g))
	var kept []Charge
	for _, c := range g {
		d := Day(c.At)
		if len(days) > 0 && days[len(days)-1].Equal(d) {
			continue
		}
		days = append(days, d)
		kept = append(kept, c)
	}
	if len(kept) < 2 {
		return Subscription{}, false
	}
	gaps := make([]int, len(days)-1)
	for i := range gaps {
		gaps[i] = daysBetween(days[i], days[i+1])
	}
	med := medianInt(gaps)
	for _, r := range rhythms {
		if med < r.minGap || med > r.maxGap || len(kept) < r.minCount {
			continue
		}
		fits := 0
		for _, gap := range gaps {
			if gap >= r.minGap && gap <= r.maxGap {
				fits++
			}
		}
		if float64(fits) < regularShare*float64(len(gaps)) {
			continue
		}
		amounts := make([]int64, len(kept))
		for i, c := range kept {
			amounts[i] = c.Amount
		}
		usual := medianInt64(amounts)
		similar := 0
		for _, a := range amounts {
			if abs64(a-usual)*100 <= usual*amountTolerancePct {
				similar++
			}
		}
		if float64(similar) < amountShare*float64(len(amounts)) {
			continue
		}
		last := kept[len(kept)-1]
		next := r.step(days[len(days)-1])
		// One missed cycle is still "overdue"; two means it has stopped.
		if r.step(next).Before(today) {
			return Subscription{}, false
		}
		s := Subscription{
			ID:       uuid.NewSHA1(subspace, []byte(userID.String()+"|"+last.Currency+"|"+merchantKey)),
			Merchant: last.Merchant, Currency: last.Currency, Amount: last.Amount, Frequency: r.freq,
			LastAt: last.At, Next: next, CardID: last.CardID, step: r.step,
		}
		for _, c := range g {
			s.Charges = append(s.Charges, c.ID)
		}
		return s, true
	}
	return Subscription{}, false
}

func medianInt(v []int) int {
	s := slices.Clone(v)
	slices.Sort(s)
	return s[len(s)/2]
}

func medianInt64(v []int64) int64 {
	s := slices.Clone(v)
	slices.Sort(s)
	return s[len(s)/2]
}

func abs64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}
