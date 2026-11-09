package money

import (
	"fmt"
	"math/big"
)

// Rounding says what to do with a fraction of a minor unit.
type Rounding int

// Rounding rules. HalfUp, Floor and Ceil match @nem/shared's divideRounded exactly, so a
// fee or a conversion rounds the same on the phone and on the server.
const (
	// HalfUp rounds half away from zero: 2.5 → 3, −2.5 → −3. The default for fees.
	HalfUp Rounding = iota + 1
	// Floor rounds toward −∞: what the customer receives in a conversion they buy.
	Floor
	// Ceil rounds toward +∞.
	Ceil
	// HalfEven rounds half to the even neighbour (banker's rounding): 2.5 → 2, 3.5 → 4.
	// For daily interest accrual, where HalfUp would add a systematic upward bias over
	// thousands of postings.
	HalfEven
)

func (r Rounding) String() string {
	switch r {
	case HalfUp:
		return "half-up"
	case Floor:
		return "floor"
	case Ceil:
		return "ceil"
	case HalfEven:
		return "half-even"
	}
	return fmt.Sprintf("Rounding(%d)", int(r))
}

// MulDiv returns a × num ÷ den, rounded by r, with the product held exactly (math/big),
// so a × num may exceed int64 as long as the result fits. ErrOverflow if it does not.
func MulDiv(a, num, den int64, r Rounding) (int64, error) {
	if den == 0 {
		return 0, ErrDivideByZero
	}
	n := new(big.Int).Mul(big.NewInt(a), big.NewInt(num))
	d := big.NewInt(den)
	if d.Sign() < 0 {
		n.Neg(n)
		d.Neg(d)
	}
	// QuoRem truncates toward zero, like Go's / and JS bigint division.
	q, rem := new(big.Int).QuoRem(n, d, new(big.Int))
	if rem.Sign() != 0 {
		neg := n.Sign() < 0
		awayFromZero := func() {
			if neg {
				q.Sub(q, big.NewInt(1))
			} else {
				q.Add(q, big.NewInt(1))
			}
		}
		switch r {
		case Floor:
			if neg {
				q.Sub(q, big.NewInt(1))
			}
		case Ceil:
			if !neg {
				q.Add(q, big.NewInt(1))
			}
		case HalfUp, HalfEven:
			twice := new(big.Int).Abs(rem)
			twice.Lsh(twice, 1)
			switch c := twice.Cmp(d); {
			case c > 0, c == 0 && r == HalfUp:
				awayFromZero()
			case c == 0 && q.Bit(0) == 1: // HalfEven on an exact half: go to the even one
				awayFromZero()
			}
		default:
			return 0, fmt.Errorf("money: unknown rounding %d", int(r))
		}
	}
	if !q.IsInt64() {
		return 0, ErrOverflow
	}
	return q.Int64(), nil
}

// DivRound returns m ÷ n rounded by r. To split an amount without losing a kobo, use
// Split instead: rounding each share cannot guarantee the shares add up.
func (m Money) DivRound(n int64, r Rounding) (Money, error) {
	q, err := MulDiv(m.amount, 1, n, r)
	if err != nil {
		return Money{}, err
	}
	return Money{amount: q, currency: m.currency}, nil
}

// BasisPoints is a rate in hundredths of a percent: 150 bp is 1.5%.
type BasisPoints int64

// PercentOf returns bp of m, rounded by r: a 1.5% fee on ₦333.33 is 499.995 kobo, which
// HalfUp makes 500 and Floor makes 499.
func (m Money) PercentOf(bp BasisPoints, r Rounding) (Money, error) {
	q, err := MulDiv(m.amount, int64(bp), 10_000, r)
	if err != nil {
		return Money{}, err
	}
	return Money{amount: q, currency: m.currency}, nil
}

// Convert turns m into another currency at an exact rate of num/den units of to per unit
// of m's currency (both currencies have two minor digits, so minor units convert at the
// same ratio). This only computes the amount; the ledger posts it through the FX position
// accounts, so each currency still balances on its own.
func (m Money) Convert(to Currency, num, den int64, r Rounding) (Money, error) {
	if !to.Valid() {
		return Money{}, ErrUnknownCurrency
	}
	if num <= 0 || den <= 0 {
		return Money{}, fmt.Errorf("money: a rate must be positive, got %d/%d", num, den)
	}
	q, err := MulDiv(m.amount, num, den, r)
	if err != nil {
		return Money{}, err
	}
	return Money{amount: q, currency: to}, nil
}
