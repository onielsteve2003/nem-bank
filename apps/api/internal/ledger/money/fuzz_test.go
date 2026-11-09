package money

import (
	"encoding/json"
	"errors"
	"math"
	"math/big"
	"testing"
)

// Native fuzz tests. `go test` runs the seeds; `go test -fuzz=FuzzX ./internal/ledger/money`
// searches for inputs that break an invariant.

// Allocation always adds back up, and no share is a whole unit off its exact proportion.
func FuzzAllocate(f *testing.F) {
	f.Add(int64(10_000), int64(1), int64(1), int64(1))
	f.Add(int64(-1), int64(3), int64(0), int64(7))
	f.Add(int64(math.MinInt64), int64(math.MaxInt64), int64(1), int64(0))
	f.Fuzz(func(t *testing.T, amount, r1, r2, r3 int64) {
		ratios := []int64{r1, r2, r3}
		parts, err := New(amount, NGN).Allocate(ratios...)
		total := new(big.Int)
		for _, r := range ratios {
			total.Add(total, big.NewInt(r))
		}
		if r1 < 0 || r2 < 0 || r3 < 0 || total.Sign() == 0 {
			if !errors.Is(err, ErrBadRatios) {
				t.Fatalf("bad ratios %v: err = %v", ratios, err)
			}
			return
		}
		if err != nil {
			t.Fatalf("allocate %d by %v: %v", amount, ratios, err)
		}
		sum := new(big.Int)
		for i, p := range parts {
			sum.Add(sum, big.NewInt(p.Amount()))
			// |share × total − amount × ratio| < total, i.e. within one minor unit.
			off := new(big.Int).Mul(big.NewInt(p.Amount()), total)
			off.Sub(off, new(big.Int).Mul(big.NewInt(amount), big.NewInt(ratios[i])))
			if off.Abs(off).Cmp(total) >= 0 {
				t.Fatalf("share %d of %d by %v is %d: more than a unit off", i, amount, ratios, p.Amount())
			}
		}
		if sum.Cmp(big.NewInt(amount)) != 0 {
			t.Fatalf("%d by %v: shares %v add up to %s", amount, ratios, parts, sum)
		}
	})
}

// MulDiv agrees with exact rational arithmetic under every rounding rule.
func FuzzMulDiv(f *testing.F) {
	f.Add(int64(33_333), int64(150), int64(10_000), uint8(0))
	f.Add(int64(-5), int64(1), int64(2), uint8(3))
	f.Add(int64(math.MaxInt64), int64(math.MaxInt64), int64(math.MinInt64), uint8(1))
	f.Fuzz(func(t *testing.T, a, num, den int64, rr uint8) {
		r := Rounding(rr%4) + HalfUp
		got, err := MulDiv(a, num, den, r)
		if den == 0 {
			if !errors.Is(err, ErrDivideByZero) {
				t.Fatalf("den 0: err = %v", err)
			}
			return
		}
		exact := new(big.Rat).SetFrac(new(big.Int).Mul(big.NewInt(a), big.NewInt(num)), big.NewInt(den))
		want := roundRat(exact, r)
		if !want.IsInt64() {
			if !errors.Is(err, ErrOverflow) {
				t.Fatalf("%d×%d/%d %s = %d, %v; want overflow", a, num, den, r, got, err)
			}
			return
		}
		if err != nil || got != want.Int64() {
			t.Fatalf("%d×%d/%d %s = %d, %v; want %s", a, num, den, r, got, err, want)
		}
	})
}

// roundRat is an independent reference: floor of x, then adjust from the fraction left.
func roundRat(x *big.Rat, r Rounding) *big.Int {
	fl := new(big.Int).Div(x.Num(), x.Denom()) // Euclidean: floor for a positive denominator
	frac := new(big.Rat).Sub(x, new(big.Rat).SetInt(fl))
	if frac.Sign() == 0 {
		return fl
	}
	up := new(big.Int).Add(fl, big.NewInt(1))
	half := big.NewRat(1, 2)
	switch r {
	case Floor:
		return fl
	case Ceil:
		return up
	case HalfUp:
		c := frac.Cmp(half)
		if c > 0 || (c == 0 && x.Sign() > 0) {
			return up
		}
		return fl
	default: // HalfEven
		c := frac.Cmp(half)
		if c > 0 || (c == 0 && fl.Bit(0) == 1) {
			return up
		}
		return fl
	}
}

// Whatever ParseMajor accepts, FormatMajor writes back to the same amount; it never panics.
func FuzzParseMajor(f *testing.F) {
	for _, s := range []string{"1,500.5", "₦20000", ".5", "7.", "-12.34", "92233720368547758.07", "-", "1e5", "٣"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, in string) {
		m, err := ParseMajor(in, NGN)
		if err != nil {
			return
		}
		back, err := ParseMajor(m.FormatMajor(), NGN)
		if err != nil || back != m {
			t.Fatalf("%q → %v → %q → %v, %v", in, m, m.FormatMajor(), back, err)
		}
	})
}

// JSON round-trips exactly, and anything that is not the contract's shape is refused.
func FuzzJSON(f *testing.F) {
	f.Add(`{"amount_minor":"150000","currency":"NGN"}`)
	f.Add(`{"amount_minor":"-9223372036854775808","currency":"USD"}`)
	f.Add(`{"amount_minor":"1e3","currency":"EUR"}`)
	f.Fuzz(func(t *testing.T, in string) {
		var m Money
		if err := json.Unmarshal([]byte(in), &m); err != nil {
			return
		}
		b, err := json.Marshal(m)
		if err != nil {
			t.Fatalf("accepted %q but cannot write it: %v", in, err)
		}
		var again Money
		if err := json.Unmarshal(b, &again); err != nil || again != m {
			t.Fatalf("%q → %s → %v, %v", in, b, again, err)
		}
	})
}

// Add and Sub return the exact result or ErrOverflow, never a wrapped number.
func FuzzAddSub(f *testing.F) {
	f.Add(int64(math.MaxInt64), int64(1))
	f.Add(int64(math.MinInt64), int64(math.MinInt64))
	f.Add(int64(-1), int64(math.MinInt64))
	f.Fuzz(func(t *testing.T, a, b int64) {
		check := func(op string, got Money, err error, want *big.Int) {
			if !want.IsInt64() {
				if !errors.Is(err, ErrOverflow) {
					t.Fatalf("%d %s %d = %v, %v; want overflow", a, op, b, got, err)
				}
				return
			}
			if err != nil || got.Amount() != want.Int64() {
				t.Fatalf("%d %s %d = %v, %v; want %s", a, op, b, got, err, want)
			}
		}
		s, err := New(a, NGN).Add(New(b, NGN))
		check("+", s, err, new(big.Int).Add(big.NewInt(a), big.NewInt(b)))
		d, err := New(a, NGN).Sub(New(b, NGN))
		check("-", d, err, new(big.Int).Sub(big.NewInt(a), big.NewInt(b)))
	})
}
