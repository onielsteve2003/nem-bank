package fx

import (
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strconv"
	"strings"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

// Rate is an exchange rate as a whole number of 1e-8: units of the quote currency per one
// unit of the base. The contract allows eight decimal places, so an integer holds every
// rate exactly and no float ever touches a conversion (code-standards §5).
type Rate int64

// rateScale is 1 in Rate units.
const rateScale = 100_000_000

// maxRate is a sanity bound (90 billion per unit), not a business rule. It keeps a rate
// times any amount inside the range MulDiv checks.
const maxRate = Rate(90_000_000_000 * rateScale)

var (
	// ErrBadRate means a string is not a rate in the contract's format.
	ErrBadRate  = errors.New("fx: not a valid rate")
	errRateTiny = errors.New("fx: rate is too small to represent")
)

var ratePattern = regexp.MustCompile(`^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$`)

// ParseRate reads the contract's decimal Rate string. Zero is refused: no market is free.
func ParseRate(s string) (Rate, error) {
	if !ratePattern.MatchString(s) {
		return 0, fmt.Errorf("%w: %q", ErrBadRate, s)
	}
	whole, frac, _ := strings.Cut(s, ".")
	w, err := strconv.ParseInt(whole, 10, 64)
	if err != nil || w >= int64(maxRate)/rateScale {
		return 0, fmt.Errorf("%w: %q is out of range", ErrBadRate, s)
	}
	f := int64(0)
	if frac != "" {
		if f, err = strconv.ParseInt((frac + "00000000")[:8], 10, 64); err != nil {
			return 0, fmt.Errorf("%w: %q", ErrBadRate, s)
		}
	}
	r := Rate(w*rateScale + f)
	if r <= 0 {
		return 0, fmt.Errorf("%w: %q must be above zero", ErrBadRate, s)
	}
	return r, nil
}

// roundRate reads a provider's number (any digits, even an exponent) and rounds it half-up
// to eight places. Providers send JSON numbers, so this goes through an exact fraction.
func roundRate(s string) (Rate, error) {
	q, ok := new(big.Rat).SetString(s)
	if !ok || q.Sign() <= 0 {
		return 0, fmt.Errorf("%w: %q", ErrBadRate, s)
	}
	scaled := new(big.Rat).Mul(q, big.NewRat(rateScale, 1))
	// Half-up on a positive fraction: floor(x + 1/2).
	scaled.Add(scaled, big.NewRat(1, 2))
	n := new(big.Int).Quo(scaled.Num(), scaled.Denom())
	if !n.IsInt64() || n.Int64() <= 0 || Rate(n.Int64()) > maxRate {
		return 0, fmt.Errorf("%w: %q is out of range", ErrBadRate, s)
	}
	return Rate(n.Int64()), nil
}

// String is the contract's decimal form, without trailing zeros: 1612.45, 0.00062017.
func (r Rate) String() string {
	whole, frac := int64(r)/rateScale, int64(r)%rateScale
	if frac == 0 {
		return strconv.FormatInt(whole, 10)
	}
	f := strings.TrimRight(fmt.Sprintf("%08d", frac), "0")
	return strconv.FormatInt(whole, 10) + "." + f
}

// Invert is 1 ÷ r, rounded down to eight places: the rate the other way round. Rounding
// down means a customer never gets more than the displayed rate gives.
func (r Rate) Invert() (Rate, error) {
	q, err := money.MulDiv(rateScale, rateScale, int64(r), money.Floor)
	if err != nil {
		return 0, err
	}
	if q <= 0 {
		return 0, errRateTiny
	}
	return Rate(q), nil
}

// Discount is r less the bank's spread, rounded down: what the bank pays when it buys the
// foreign currency from a customer. Spread is in basis points.
func (r Rate) Discount(bps int) (Rate, error) {
	q, err := money.MulDiv(int64(r), int64(10_000-bps), 10_000, money.Floor)
	return Rate(q), err
}

// Markup is r plus the bank's spread, rounded up: what the bank charges when it sells the
// foreign currency to a customer. The fraction of a unit stays with the bank.
func (r Rate) Markup(bps int) (Rate, error) {
	q, err := money.MulDiv(int64(r), int64(10_000+bps), 10_000, money.Ceil)
	return Rate(q), err
}

// Apply is amount (minor units) × r, rounded as named. Both currencies have two minor
// digits, so minor units convert at the same ratio as major ones.
func (r Rate) Apply(amountMinor int64, rounding money.Rounding) (int64, error) {
	return money.MulDiv(amountMinor, int64(r), rateScale, rounding)
}

// Divide is amount (minor units) ÷ r, rounded as named: how much to sell to receive a
// fixed amount.
func (r Rate) Divide(amountMinor int64, rounding money.Rounding) (int64, error) {
	return money.MulDiv(amountMinor, rateScale, int64(r), rounding)
}

// cross is a ÷ b as a Rate, rounded half-up: the naira price of a currency, from two
// per-dollar quotes.
func cross(a, b Rate) (Rate, error) {
	q, err := money.MulDiv(int64(a), rateScale, int64(b), money.HalfUp)
	if err != nil {
		return 0, err
	}
	return Rate(q), nil
}
