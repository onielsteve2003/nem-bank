package money

import (
	"errors"
	"math/big"
	"sort"
)

// ErrBadRatios means Allocate got no ratios, a negative one, or ratios that sum to zero.
var ErrBadRatios = errors.New("money: ratios must be non-negative and sum to more than zero")

// Allocate splits m in proportion to ratios, and the shares always add up to m exactly:
// no kobo is created or lost. Each share is the exact proportion rounded down; the minor
// units left over go one each to the shares with the largest remainders (the
// largest-remainder method), ties to the earlier share. So no share is more than one minor
// unit away from its exact proportion, and the order of ties is stable.
//
// A negative amount is split as its absolute value, then negated, so −₦1 split three ways
// is −34, −33, −33 kobo: the mirror image of +₦1.
func (m Money) Allocate(ratios ...int64) ([]Money, error) {
	if len(ratios) == 0 {
		return nil, ErrBadRatios
	}
	total := new(big.Int)
	for _, r := range ratios {
		if r < 0 {
			return nil, ErrBadRatios
		}
		total.Add(total, big.NewInt(r))
	}
	if total.Sign() == 0 {
		return nil, ErrBadRatios
	}

	// Work on |m| as a big.Int: |MinInt64| does not fit an int64.
	amount := big.NewInt(m.amount)
	neg := amount.Sign() < 0
	amount.Abs(amount)

	shares := make([]*big.Int, len(ratios))
	rems := make([]*big.Int, len(ratios))
	given := new(big.Int)
	for i, r := range ratios {
		exact := new(big.Int).Mul(amount, big.NewInt(r))
		shares[i], rems[i] = new(big.Int).QuoRem(exact, total, new(big.Int))
		given.Add(given, shares[i])
	}
	left := new(big.Int).Sub(amount, given).Int64() // fewer than len(ratios)

	order := make([]int, len(ratios))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool { return rems[order[a]].Cmp(rems[order[b]]) > 0 })
	for k := range left {
		shares[order[k]].Add(shares[order[k]], big.NewInt(1))
	}

	out := make([]Money, len(ratios))
	for i, s := range shares {
		if neg {
			s.Neg(s)
		}
		// Each share is at most |m|, so it fits; the check guards the MinInt64 corner.
		if !s.IsInt64() {
			return nil, ErrOverflow
		}
		out[i] = Money{amount: s.Int64(), currency: m.currency}
	}
	return out, nil
}

// Split divides m into n near-equal shares that add up to m; the first shares take the
// leftover minor units. ₦100.00 three ways is 3334, 3333, 3333 kobo.
func (m Money) Split(n int) ([]Money, error) {
	if n < 1 {
		return nil, ErrBadRatios
	}
	ratios := make([]int64, n)
	for i := range ratios {
		ratios[i] = 1
	}
	return m.Allocate(ratios...)
}
