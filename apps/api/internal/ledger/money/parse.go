package money

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// ErrSyntax is returned for text that is not an amount.
var ErrSyntax = errors.New("money: not a valid amount")

// ErrPrecision is returned for more decimals than the currency has. They are refused, not
// rounded: a customer who typed ₦10.005 meant something, and guessing is not our job.
var ErrPrecision = errors.New("money: too many decimal places")

var symbols = map[Currency]string{NGN: "₦", USD: "$", GBP: "£", EUR: "€"}

// ParseMajor reads a major-unit amount as a person types it ("1,500.5", "₦20000", ".5",
// "-12.34") into minor units. It is @nem/shared's parseMajor, rule for rule.
func ParseMajor(input string, c Currency) (Money, error) {
	if !c.Valid() {
		return Money{}, ErrUnknownCurrency
	}
	s := strings.TrimSpace(input)
	s = strings.NewReplacer(symbols[c], "", ",", "", " ", "").Replace(s)
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")
	whole, frac, _ := strings.Cut(s, ".")
	if (whole == "" && frac == "") || !digits(whole) || !digits(frac) {
		return Money{}, fmt.Errorf("%w: %q", ErrSyntax, input)
	}
	if len(frac) > c.MinorDigits() {
		return Money{}, fmt.Errorf("%w: %s allows %d", ErrPrecision, c, c.MinorDigits())
	}
	if whole == "" {
		whole = "0"
	}
	frac += strings.Repeat("0", c.MinorDigits()-len(frac))
	digitsStr := whole + frac
	if neg {
		digitsStr = "-" + digitsStr
	}
	n, err := strconv.ParseInt(digitsStr, 10, 64)
	if err != nil {
		return Money{}, fmt.Errorf("%w: %q", ErrOverflow, input)
	}
	return Money{amount: n, currency: c}, nil
}

func digits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// FormatMajor writes m in major units with every minor digit and no grouping: "1500.00",
// "-0.05". ParseMajor reads it back to the same amount.
func (m Money) FormatMajor() string {
	d := m.currency.MinorDigits()
	if !m.currency.Valid() {
		d = 2
	}
	s := strconv.FormatInt(m.amount, 10)
	sign := ""
	if strings.HasPrefix(s, "-") {
		sign, s = "-", s[1:]
	}
	if len(s) <= d {
		s = strings.Repeat("0", d-len(s)+1) + s
	}
	return sign + s[:len(s)-d] + "." + s[len(s)-d:]
}

// wire is the contract's Money: {"amount_minor": "150000", "currency": "NGN"}. The amount
// is a string so JavaScript clients never round it through a float64.
type wire struct {
	AmountMinor string `json:"amount_minor"`
	Currency    string `json:"currency"`
}

// ParseMinor reads the contract's amount_minor string: an optional minus and digits with
// no leading zeros ('^-?(0|[1-9][0-9]*)$'). No plus sign, spaces, decimals or exponents.
func ParseMinor(amountMinor, currency string) (Money, error) {
	c, err := ParseCurrency(currency)
	if err != nil {
		return Money{}, err
	}
	body := strings.TrimPrefix(amountMinor, "-")
	if body == "" || !digits(body) || (len(body) > 1 && body[0] == '0') {
		return Money{}, fmt.Errorf("%w: amount_minor %q", ErrSyntax, amountMinor)
	}
	n, err := strconv.ParseInt(amountMinor, 10, 64)
	if err != nil {
		return Money{}, fmt.Errorf("%w: amount_minor %q", ErrOverflow, amountMinor)
	}
	return Money{amount: n, currency: c}, nil
}

// MarshalJSON writes the contract's Money shape.
func (m Money) MarshalJSON() ([]byte, error) {
	if !m.currency.Valid() {
		return nil, fmt.Errorf("%w: %q", ErrUnknownCurrency, m.currency)
	}
	b, err := json.Marshal(wire{AmountMinor: strconv.FormatInt(m.amount, 10), Currency: string(m.currency)})
	if err != nil {
		return nil, fmt.Errorf("marshal money: %w", err)
	}
	return b, nil
}

// UnmarshalJSON reads the contract's Money shape, strictly.
func (m *Money) UnmarshalJSON(b []byte) error {
	var w wire
	if err := json.Unmarshal(b, &w); err != nil {
		return fmt.Errorf("%w: %w", ErrSyntax, err)
	}
	v, err := ParseMinor(w.AmountMinor, w.Currency)
	if err != nil {
		return err
	}
	*m = v
	return nil
}
