package money

import (
	"encoding/json"
	"errors"
	"math"
	"testing"
)

func TestArithmeticRefusesMixedCurrenciesAndOverflow(t *testing.T) {
	t.Parallel()
	ngn := New(150_000, NGN)
	if s, err := ngn.Add(New(50, NGN)); err != nil || s != New(150_050, NGN) {
		t.Fatalf("add = %v, %v", s, err)
	}
	if _, err := ngn.Add(New(1, USD)); !errors.Is(err, ErrCurrencyMismatch) {
		t.Fatalf("NGN + USD: err = %v", err)
	}
	if _, err := ngn.Cmp(New(1, USD)); !errors.Is(err, ErrCurrencyMismatch) {
		t.Fatalf("compare NGN with USD: err = %v", err)
	}
	for name, f := range map[string]func() (Money, error){
		"max + 1":      func() (Money, error) { return New(math.MaxInt64, NGN).Add(New(1, NGN)) },
		"min + (-1)":   func() (Money, error) { return New(math.MinInt64, NGN).Add(New(-1, NGN)) },
		"0 - min":      func() (Money, error) { return New(0, NGN).Sub(New(math.MinInt64, NGN)) },
		"min - 1":      func() (Money, error) { return New(math.MinInt64, NGN).Sub(New(1, NGN)) },
		"-min":         func() (Money, error) { return New(math.MinInt64, NGN).Neg() },
		"|min|":        func() (Money, error) { return New(math.MinInt64, NGN).Abs() },
		"max × 2":      func() (Money, error) { return New(math.MaxInt64, NGN).MulInt(2) },
		"sum past max": func() (Money, error) { return Sum(NGN, New(math.MaxInt64, NGN), New(1, NGN)) },
	} {
		if _, err := f(); !errors.Is(err, ErrOverflow) {
			t.Errorf("%s: err = %v, want ErrOverflow", name, err)
		}
	}
	// Right at the edges is fine.
	if s, err := New(-1, NGN).Sub(New(math.MinInt64, NGN)); err != nil || s.Amount() != math.MaxInt64 {
		t.Errorf("-1 - min = %v, %v", s, err)
	}
	if s, err := Sum(USD); err != nil || s != Zero(USD) {
		t.Errorf("empty sum = %v, %v", s, err)
	}
}

// The first eight rows are @nem/shared's divideRounded vectors, so both sides agree.
func TestRoundingRules(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		n, d int64
		r    Rounding
		want int64
	}{
		{5, 2, HalfUp, 3}, {-5, 2, HalfUp, -3}, {4, 3, HalfUp, 1}, {5, 2, Floor, 2},
		{-5, 2, Floor, -3}, {5, 2, Ceil, 3}, {-5, 2, Ceil, -2}, {6, 2, Ceil, 3},
		{5, 2, HalfEven, 2}, {7, 2, HalfEven, 4}, {-5, 2, HalfEven, -2}, {-7, 2, HalfEven, -4},
		{5, -2, Floor, -3}, {-5, -2, HalfUp, 3}, {7, 3, HalfEven, 2}, {8, 3, HalfEven, 3},
	} {
		if got, err := MulDiv(tc.n, 1, tc.d, tc.r); err != nil || got != tc.want {
			t.Errorf("%d / %d %s = %d, %v; want %d", tc.n, tc.d, tc.r, got, err, tc.want)
		}
	}
	if _, err := MulDiv(1, 1, 0, HalfUp); !errors.Is(err, ErrDivideByZero) {
		t.Error("division by zero accepted")
	}
	// The product may pass int64 when the result fits.
	if got, err := MulDiv(math.MaxInt64, 10, 20, Floor); err != nil || got != math.MaxInt64/2 {
		t.Errorf("max × 10 / 20 = %d, %v", got, err)
	}
	if _, err := MulDiv(math.MaxInt64, 3, 2, Floor); !errors.Is(err, ErrOverflow) {
		t.Errorf("max × 3 / 2: err = %v", err)
	}
}

func TestFeesAndConversionsRoundWhereTheCallerSays(t *testing.T) {
	t.Parallel()
	// @nem/shared: 1.5% of ₦333.33 is 499.995 kobo.
	if f, _ := New(33_333, NGN).PercentOf(150, HalfUp); f.Amount() != 500 {
		t.Errorf("half-up fee = %v", f)
	}
	if f, _ := New(33_333, NGN).PercentOf(150, Floor); f.Amount() != 499 {
		t.Errorf("floor fee = %v", f)
	}
	// ₦150,000.00 at 1/1,612.35 USD per naira (161235/100 NGN per USD), rounded down.
	usd, err := New(15_000_000, NGN).Convert(USD, 100, 161_235, Floor)
	if err != nil || usd != New(9_303, USD) {
		t.Errorf("convert = %v, %v; want $93.03", usd, err)
	}
	if _, err := New(1, NGN).Convert(USD, 0, 1, Floor); err == nil {
		t.Error("a zero rate was accepted")
	}
}

func TestAllocationNeverLosesAKobo(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		m      Money
		ratios []int64
		want   []int64
	}{
		{New(10_000, NGN), []int64{1, 1, 1}, []int64{3334, 3333, 3333}},
		{New(-100, NGN), []int64{1, 1, 1}, []int64{-34, -33, -33}},
		{New(5, NGN), []int64{70, 30}, []int64{4, 1}},                // 3.5 and 1.5: tie, earlier wins
		{New(100, NGN), []int64{1, 2, 3, 0}, []int64{17, 33, 50, 0}}, // 16.67, 33.33, 50: largest remainder
		{New(math.MinInt64, USD), []int64{1, 1}, []int64{math.MinInt64 / 2, math.MinInt64 / 2}},
	} {
		got, err := tc.m.Allocate(tc.ratios...)
		if err != nil {
			t.Fatalf("%v by %v: %v", tc.m, tc.ratios, err)
		}
		for i := range got {
			if got[i] != New(tc.want[i], tc.m.Currency()) {
				t.Errorf("%v by %v = %v, want %v", tc.m, tc.ratios, got, tc.want)
				break
			}
		}
	}
	for _, bad := range [][]int64{nil, {0, 0}, {1, -1}} {
		if _, err := New(1, NGN).Allocate(bad...); !errors.Is(err, ErrBadRatios) {
			t.Errorf("ratios %v: err = %v", bad, err)
		}
	}
	if parts, _ := New(100, NGN).Split(3); parts[0].Amount() != 34 || parts[2].Amount() != 33 {
		t.Errorf("split = %v", parts)
	}
}

// The first rows are @nem/shared's parseMajor vectors.
func TestParseMajorMatchesTheApp(t *testing.T) {
	t.Parallel()
	for in, want := range map[string]int64{
		"1,500.5": 150_050, "₦20000": 2_000_000, ".5": 50, "7.": 700, "-12.34": -1_234,
		" 0.01 ": 1, "92233720368547758.07": math.MaxInt64,
	} {
		if m, err := ParseMajor(in, NGN); err != nil || m.Amount() != want {
			t.Errorf("%q = %v, %v; want %d", in, m, err, want)
		}
	}
	for in, want := range map[string]error{
		"": ErrSyntax, "12a": ErrSyntax, "-": ErrSyntax, ".": ErrSyntax, "1.2.3": ErrSyntax, "--1": ErrSyntax,
		"1e5": ErrSyntax, "1.005": ErrPrecision, "92233720368547758.08": ErrOverflow,
	} {
		if _, err := ParseMajor(in, NGN); !errors.Is(err, want) {
			t.Errorf("%q: err = %v, want %v", in, err, want)
		}
	}
	if _, err := ParseMajor("$5", NGN); !errors.Is(err, ErrSyntax) {
		t.Error("a dollar sign was accepted for naira")
	}
	for m, want := range map[Money]string{New(150_000, NGN): "1500.00", New(-5, USD): "-0.05", New(0, EUR): "0.00", New(7, GBP): "0.07"} {
		if got := m.FormatMajor(); got != want {
			t.Errorf("format %d = %q, want %q", m.Amount(), got, want)
		}
	}
}

func TestJSONIsTheContractsMoney(t *testing.T) {
	t.Parallel()
	b, err := json.Marshal(New(150_000, NGN))
	if err != nil || string(b) != `{"amount_minor":"150000","currency":"NGN"}` {
		t.Fatalf("marshal = %s, %v", b, err)
	}
	var m Money
	if err := json.Unmarshal([]byte(`{"amount_minor":"-9223372036854775808","currency":"USD"}`), &m); err != nil || m != New(math.MinInt64, USD) {
		t.Fatalf("unmarshal min = %v, %v", m, err)
	}
	for _, bad := range []string{
		`{"amount_minor":"1.5","currency":"NGN"}`, `{"amount_minor":150000,"currency":"NGN"}`,
		`{"amount_minor":"+1","currency":"NGN"}`, `{"amount_minor":"007","currency":"NGN"}`,
		`{"amount_minor":"1","currency":"JPY"}`, `{"amount_minor":"9223372036854775808","currency":"NGN"}`,
		`{"amount_minor":"","currency":"NGN"}`,
	} {
		if err := json.Unmarshal([]byte(bad), &m); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
	if _, err := json.Marshal(Money{}); err == nil {
		t.Error("marshalled a Money with no currency")
	}
}
