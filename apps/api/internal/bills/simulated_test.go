package bills

import (
	"errors"
	"strings"
	"testing"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

func TestDetectNetworkFromThePrefix(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ phone, want string }{
		{"08031234567", MTN},
		{"+2348031234567", MTN},
		{"2348021234567", Airtel},
		{"0805 123 4567", Glo},
		{"0809-123-4567", NineMobile},
		{"07011234567", Airtel},
		{"08991234567", ""},  // unallocated prefix
		{"0803123456", ""},   // too short
		{"abc", ""},          // not a number
		{"+14155550123", ""}, // not Nigerian
	} {
		if got := DetectNetwork(tc.phone); got != tc.want {
			t.Errorf("DetectNetwork(%q) = %q, want %q", tc.phone, got, tc.want)
		}
	}
}

func TestNormalizePhoneGivesE164(t *testing.T) {
	t.Parallel()
	for _, in := range []string{"08031234567", "2348031234567", "+2348031234567", "0803 123 4567"} {
		if got, ok := NormalizePhone(in); !ok || got != "+2348031234567" {
			t.Errorf("NormalizePhone(%q) = %q, %v", in, got, ok)
		}
	}
	for _, in := range []string{"", "0603123456", "080312345678", "+44 7911 123456"} {
		if got, ok := NormalizePhone(in); ok {
			t.Errorf("NormalizePhone(%q) = %q, want refusal", in, got)
		}
	}
}

func TestSimulatedCatalogMatchesTheMockBank(t *testing.T) {
	t.Parallel()
	list, err := Simulated{}.Billers(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, b := range list {
		counts[b.Category]++
		// Billers with plans must list some, so the app never shows an empty picker.
		ps, err := Simulated{}.Products(t.Context(), b.ID)
		if err != nil || (b.HasProducts) != (len(ps) > 0) {
			t.Errorf("%s: has_products=%v but %d products (%v)", b.ID, b.HasProducts, len(ps), err)
		}
		for i := 1; i < len(ps); i++ {
			if ps[i].Amount.Amount() < ps[i-1].Amount.Amount() {
				t.Errorf("%s: products are not cheapest first", b.ID)
			}
		}
	}
	if counts[Airtime] != 4 || counts[Data] != 4 || counts[Electricity] != 3 || counts[CableTV] != 3 {
		t.Fatalf("catalog = %v", counts)
	}
	if _, err := (Simulated{}).Products(t.Context(), "nope"); !errors.Is(err, ErrUnknownBiller) {
		t.Fatalf("unknown biller err = %v", err)
	}
}

func TestSimulatedValidateMetersAndSmartcards(t *testing.T) {
	t.Parallel()
	s := Simulated{}
	c, err := s.Validate(t.Context(), "ikeja-electric-prepaid", "12345678901")
	if err != nil || c.Name == "" || c.Address == "" {
		t.Fatalf("meter = %+v, %v", c, err)
	}
	again, _ := s.Validate(t.Context(), "ikeja-electric-prepaid", "12345678901")
	if again.Name != c.Name {
		t.Fatalf("the same meter changed owner: %q then %q", c.Name, again.Name)
	}
	card, err := s.Validate(t.Context(), "dstv", "1234567890")
	if err != nil || card.CurrentPlan != "DStv Compact" {
		t.Fatalf("smartcard = %+v, %v", card, err)
	}
	for _, tc := range []struct{ biller, id string }{
		{"ikeja-electric-prepaid", "12340000000"}, // 0000 ending: no such meter... (11 digits ending 0000)
		{"ikeja-electric-prepaid", "1234567890"},  // a smartcard's length
		{"dstv", "12345670000"},                   // a meter's length
		{"dstv", "12345abcde"},
		{"dstv", ""},
	} {
		if _, err := s.Validate(t.Context(), tc.biller, tc.id); !errors.Is(err, ErrCustomerNotFound) {
			t.Errorf("Validate(%s, %q) err = %v, want not found", tc.biller, tc.id, err)
		}
	}
}

func TestSimulatedVendIsIdempotentAndShapesTheToken(t *testing.T) {
	t.Parallel()
	s := Simulated{}
	req := VendRequest{Reference: "BIL-ABC", BillerID: "eko-electric-prepaid", CustomerID: "12345678901", Amount: money.New(4_500_00, money.NGN)}
	a, err := s.Vend(t.Context(), req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := s.Vend(t.Context(), req)
	if a != b {
		t.Fatalf("a retry returned a different result: %+v then %+v", a, b)
	}
	parts := strings.Split(a.Token, "-")
	if len(parts) != 5 {
		t.Fatalf("token %q is not five groups", a.Token)
	}
	for _, p := range parts {
		if len(p) != 4 || !allDigits(p) {
			t.Fatalf("token %q has a bad group %q", a.Token, p)
		}
	}
	// ₦4,500 at ₦225 per kWh is exactly 20 kWh.
	if a.Units != "20.0 kWh" {
		t.Fatalf("units = %q", a.Units)
	}
	// ₦1,000 is 4.44… kWh, shown rounded down.
	req.Amount = money.New(1_000_00, money.NGN)
	if r, _ := s.Vend(t.Context(), req); r.Units != "4.4 kWh" {
		t.Fatalf("units = %q, want 4.4 kWh", r.Units)
	}
	other := req
	other.Reference = "BIL-XYZ"
	if r, _ := s.Vend(t.Context(), other); r.Token == a.Token {
		t.Fatal("two payments got the same token")
	}
	// Airtime has no token.
	air, err := s.Vend(t.Context(), VendRequest{Reference: "BIL-1", BillerID: "mtn-airtime", CustomerID: "+2348031234567", Amount: money.New(100_00, money.NGN)})
	if err != nil || air != (VendResult{}) {
		t.Fatalf("airtime = %+v, %v", air, err)
	}
}

func TestSimulatedRefusesCustomersEndingNineNineNineNine(t *testing.T) {
	t.Parallel()
	_, err := Simulated{}.Vend(t.Context(), VendRequest{Reference: "BIL-1", BillerID: "mtn-airtime", CustomerID: "+2348031239999", Amount: money.New(100_00, money.NGN)})
	if !errors.Is(err, ErrVendRejected) {
		t.Fatalf("err = %v", err)
	}
}
