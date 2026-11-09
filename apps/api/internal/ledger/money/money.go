// Package money is the API's only representation of an amount of money: int64 minor units
// (kobo, cents, pence) with a currency. It is the Go twin of @nem/shared's Money and
// follows the same rules (code standards §5):
//
//   - No floats, anywhere. Rates and percentages are integer ratios.
//   - Every operation checks the currency. Mixing currencies needs an FX entry, so it is
//     an error here, never a silent sum.
//   - Every operation checks for int64 overflow and returns ErrOverflow instead of
//     wrapping around. A wrapped balance is the worst bug a ledger can have.
//   - Rounding is never implied: any operation that can produce a fraction takes a
//     Rounding, so the rule is visible at the call site.
package money

import (
	"errors"
	"fmt"
	"math"
)

// Currency is an ISO 4217 code the bank supports (contract CurrencyCode).
type Currency string

// Supported currencies.
const (
	NGN Currency = "NGN"
	USD Currency = "USD"
	GBP Currency = "GBP"
	EUR Currency = "EUR"
)

// Currencies lists every supported currency.
var Currencies = []Currency{NGN, USD, GBP, EUR}

// ErrUnknownCurrency is returned for a code outside Currencies.
var ErrUnknownCurrency = errors.New("money: unsupported currency")

// ParseCurrency checks an ISO code from outside (a request, a row).
func ParseCurrency(code string) (Currency, error) {
	c := Currency(code)
	if !c.Valid() {
		return "", fmt.Errorf("%w: %q", ErrUnknownCurrency, code)
	}
	return c, nil
}

// Valid reports whether c is supported.
func (c Currency) Valid() bool {
	switch c {
	case NGN, USD, GBP, EUR:
		return true
	}
	return false
}

// MinorDigits is the number of minor-unit decimals: 2 for all four (ISO 4217).
func (c Currency) MinorDigits() int { return 2 }

// Errors from arithmetic.
var (
	ErrCurrencyMismatch = errors.New("money: currencies differ; convert through an FX entry")
	ErrOverflow         = errors.New("money: amount out of range")
	ErrDivideByZero     = errors.New("money: division by zero")
)

// Money is an amount in minor units. The zero value has no currency and is not valid; use
// New or Zero.
type Money struct {
	amount   int64
	currency Currency
}

// New is minor units of a currency: New(150000, NGN) is ₦1,500.00.
func New(minor int64, c Currency) Money { return Money{amount: minor, currency: c} }

// Zero is nothing, in c.
func Zero(c Currency) Money { return Money{currency: c} }

// Amount is the signed amount in minor units.
func (m Money) Amount() int64 { return m.amount }

// Currency is the amount's currency.
func (m Money) Currency() Currency { return m.currency }

// IsZero reports whether m is nothing.
func (m Money) IsZero() bool { return m.amount == 0 }

// IsNegative reports whether m is below zero (a debit, in a posting).
func (m Money) IsNegative() bool { return m.amount < 0 }

// IsPositive reports whether m is above zero (a credit, in a posting).
func (m Money) IsPositive() bool { return m.amount > 0 }

func (m Money) same(o Money) error {
	if m.currency != o.currency {
		return fmt.Errorf("%w: %s and %s", ErrCurrencyMismatch, m.currency, o.currency)
	}
	return nil
}

// Add returns m + o.
func (m Money) Add(o Money) (Money, error) {
	if err := m.same(o); err != nil {
		return Money{}, err
	}
	s := m.amount + o.amount
	// Signed overflow happened iff both operands share a sign the result does not.
	if (m.amount >= 0) == (o.amount >= 0) && (s >= 0) != (m.amount >= 0) {
		return Money{}, ErrOverflow
	}
	return Money{amount: s, currency: m.currency}, nil
}

// Sub returns m − o.
func (m Money) Sub(o Money) (Money, error) {
	if err := m.same(o); err != nil {
		return Money{}, err
	}
	if o.amount == math.MinInt64 {
		// −MinInt64 does not exist; m − MinInt64 fits only when m is negative.
		if m.amount >= 0 {
			return Money{}, ErrOverflow
		}
		return Money{amount: m.amount - o.amount, currency: m.currency}, nil
	}
	return m.Add(Money{amount: -o.amount, currency: o.currency})
}

// Neg returns −m.
func (m Money) Neg() (Money, error) {
	if m.amount == math.MinInt64 {
		return Money{}, ErrOverflow
	}
	return Money{amount: -m.amount, currency: m.currency}, nil
}

// Abs returns |m|.
func (m Money) Abs() (Money, error) {
	if m.amount < 0 {
		return m.Neg()
	}
	return m, nil
}

// Cmp returns −1, 0 or +1 as m is less than, equal to or greater than o.
func (m Money) Cmp(o Money) (int, error) {
	if err := m.same(o); err != nil {
		return 0, err
	}
	switch {
	case m.amount < o.amount:
		return -1, nil
	case m.amount > o.amount:
		return 1, nil
	}
	return 0, nil
}

// Equal reports whether m and o are the same amount in the same currency.
func (m Money) Equal(o Money) bool { return m == o }

// Sum adds amounts in c. An empty list is Zero(c), so the currency is always known.
func Sum(c Currency, items ...Money) (Money, error) {
	total := Zero(c)
	for _, it := range items {
		var err error
		if total, err = total.Add(it); err != nil {
			return Money{}, err
		}
	}
	return total, nil
}

// MulInt returns m × n, for quantities (12 monthly instalments, 3 tickets).
func (m Money) MulInt(n int64) (Money, error) {
	r, err := MulDiv(m.amount, n, 1, Floor) // exact: the divisor is 1
	if err != nil {
		return Money{}, err
	}
	return Money{amount: r, currency: m.currency}, nil
}

// String is for logs and errors: "1500.00 NGN". Customer-facing formatting (symbols,
// grouping, locale) is the clients' job.
func (m Money) String() string { return m.FormatMajor() + " " + string(m.currency) }
