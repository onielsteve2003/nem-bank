package fx

import (
	"errors"
	"testing"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

func TestParseRateReadsTheContractFormatExactly(t *testing.T) {
	t.Parallel()
	for in, want := range map[string]Rate{
		"1":          100_000_000,
		"1612.45":    161_245_000_000,
		"0.00062017": 62_017,
		"0.5":        50_000_000,
		"0.00000001": 1,
	} {
		got, err := ParseRate(in)
		if err != nil || got != want {
			t.Errorf("ParseRate(%q) = %d, %v; want %d", in, got, err, want)
		}
		if back := got.String(); back != in {
			t.Errorf("String() = %q, want %q", back, in)
		}
	}
	for _, in := range []string{"", "0", "0.0", "-1", "1.", ".5", "01.5", "1.123456789", "1e3", "abc", "1,5", "99999999999999"} {
		if r, err := ParseRate(in); !errors.Is(err, ErrBadRate) {
			t.Errorf("ParseRate(%q) = %d, %v; want ErrBadRate", in, r, err)
		}
	}
}

func TestRoundRateAcceptsProviderNumbers(t *testing.T) {
	t.Parallel()
	for in, want := range map[string]Rate{
		"1612.45":       161_245_000_000,
		"0.77521668123": 77_521_668, // rounded half-up at eight places
		"0.123456785":   12_345_679, // exactly half: up
		"0.123456784":   12_345_678,
		"1.5e-3":        150_000,
		"1585":          158_500_000_000,
	} {
		if got, err := roundRate(in); err != nil || got != want {
			t.Errorf("roundRate(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	for _, in := range []string{"0", "-3", "NaN", "", "1e30", "0.000000001"} {
		if r, err := roundRate(in); err == nil {
			t.Errorf("roundRate(%q) = %d; want an error", in, r)
		}
	}
}

func TestSpreadAlwaysFavoursTheBank(t *testing.T) {
	t.Parallel()
	mid, _ := ParseRate("1612.45")
	buy, err := mid.Discount(150)
	if err != nil || buy.String() != "1588.26325" { // 1612.45 x 0.985 exactly
		t.Fatalf("buy = %s, %v", buy, err)
	}
	sell, err := mid.Markup(150)
	if err != nil || sell.String() != "1636.63675" {
		t.Fatalf("sell = %s, %v", sell, err)
	}
	// An uneven rate rounds against the customer on both sides.
	odd := Rate(333_333_333)
	d, _ := odd.Discount(150)
	u, _ := odd.Markup(150)
	if d != 328_333_333 || u != 338_333_333 { // 328333333.005 down; 338333332.995 up
		t.Fatalf("odd rate: discount %d, markup %d", d, u)
	}
	if d >= odd || u <= odd {
		t.Fatalf("spread did not straddle the mid: %d < %d < %d", d, odd, u)
	}
}

func TestInvertRoundsDownSoARoundTripNeverGains(t *testing.T) {
	t.Parallel()
	r, _ := ParseRate("1612.45")
	inv, err := r.Invert()
	if err != nil || inv.String() != "0.00062017" {
		t.Fatalf("invert = %s, %v", inv, err)
	}
	// Naira to dollars at the rounded-down inverse, then back at the rate: never more than
	// the naira put in, so the rounding cannot create money.
	for _, minor := range []int64{1, 99, 100_00, 1_234_567_89, 9_999_999_999_99} {
		dollars, _ := inv.Apply(minor, money.Floor)
		back, _ := r.Apply(dollars, money.Floor)
		if back > minor {
			t.Errorf("%d kobo became %d cents and came back as %d kobo", minor, dollars, back)
		}
	}
	if _, err := Rate(1).Invert(); err != nil {
		t.Errorf("1e-8 inverts to 1e8: %v", err)
	}
	if _, err := Rate(rateScale * 1_000_000_000).Invert(); !errors.Is(err, errRateTiny) {
		t.Errorf("a rate this large inverts to nothing, got %v", err)
	}
}

func TestApplyAndDivideAreExactWithTheNamedRounding(t *testing.T) {
	t.Parallel()
	r, _ := ParseRate("1588.26325")
	// $100.00 is 15,882,632.5 kobo.
	if got, _ := r.Apply(10_000, money.Floor); got != 15_882_632 {
		t.Errorf("sell $100 = %d kobo", got)
	}
	if got, _ := r.Apply(10_000, money.Ceil); got != 15_882_633 {
		t.Errorf("ceil = %d", got)
	}
	// To receive at least 15,882,633 kobo the customer sells the ceiling of the quotient.
	need, _ := r.Divide(15_882_633, money.Ceil)
	if got, _ := r.Apply(need, money.Floor); got < 15_882_633 {
		t.Errorf("selling %d minor yields %d, short of the 15882633 asked", need, got)
	}
	if _, err := r.Apply(1<<62, money.Floor); !errors.Is(err, money.ErrOverflow) {
		t.Errorf("overflow = %v", err)
	}
}

func TestCrossRateIsRoundedHalfUp(t *testing.T) {
	t.Parallel()
	ngn, _ := ParseRate("1612.45")
	gbp, _ := ParseRate("0.7752")
	got, err := cross(ngn, gbp)
	if err != nil || got.String() != "2080.04385965" { // 2080.0438596491...
		t.Fatalf("GBP-NGN = %s, %v", got, err)
	}
	if usd, _ := cross(ngn, rateScale); usd != ngn {
		t.Fatalf("USD-NGN = %s", usd)
	}
}
