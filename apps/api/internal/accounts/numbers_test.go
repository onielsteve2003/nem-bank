package accounts

import "testing"

func TestNubanCheckDigitMatchesTheCBNExample(t *testing.T) {
	t.Parallel()
	// The CBN's worked example: First Bank (011), serial 000001457 → 0000014579. The
	// revised six-digit form ("000011") must give the same digit as the original.
	for _, tc := range []struct {
		bank, serial string
		want         int
	}{
		{"011", "000001457", 9},
		{"000011", "000001457", 9},
		{"090999", "100000000", 7}, // 9·7+9·3+9·7+9·3+1·3 = 183
		{"090999", "100000001", 4},
	} {
		got, err := NubanCheckDigit(tc.bank, tc.serial)
		if err != nil || got != tc.want {
			t.Errorf("NubanCheckDigit(%s, %s) = %d, %v; want %d", tc.bank, tc.serial, got, err, tc.want)
		}
	}
}

func TestNubanRejectsMalformedInput(t *testing.T) {
	t.Parallel()
	for _, tc := range [][2]string{{"0111", "000001457"}, {"011", "00001457"}, {"011", "00000145x"}} {
		if _, err := NubanCheckDigit(tc[0], tc[1]); err == nil {
			t.Errorf("NubanCheckDigit(%s, %s) accepted", tc[0], tc[1])
		}
	}
	if ValidNuban("011", "0000014578") || ValidNuban("011", "000001457") || !ValidNuban("011", "0000014579") {
		t.Error("ValidNuban misjudged the CBN example")
	}
}

func TestGeneratedNumbersAreValid(t *testing.T) {
	t.Parallel()
	for _, serial := range []int64{100000000, 123456789, 999999999} {
		n, err := nubanFor(serial)
		if err != nil || len(n) != 10 || !ValidNuban(BankCode, n) {
			t.Errorf("nubanFor(%d) = %q, %v", serial, n, err)
		}
	}
	if w := walletNumberFor(42); w != "8400000042" {
		t.Errorf("walletNumberFor(42) = %q", w)
	}
}

func TestIBANCheckDigits(t *testing.T) {
	t.Parallel()
	// The ISO 13616 example IBAN for Germany.
	if !validIBAN("DE89370400440532013000") || validIBAN("DE88370400440532013000") {
		t.Fatal("validIBAN misjudged the ISO example")
	}
	for _, acct := range []string{"8400000001", "8400000042", "8499999999"} {
		iban := germanIBAN(acct)
		if len(iban) != 22 || !validIBAN(iban) {
			t.Errorf("germanIBAN(%s) = %s, not a valid German IBAN", acct, iban)
		}
	}
}
