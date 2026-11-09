package admin

import (
	"strings"
	"testing"
	"time"
)

// RFC 6238 Appendix B, SHA-1 rows; the RFC prints 8 digits, a 6-digit code is the last 6.
func TestTOTPMatchesTheRFCTestVectors(t *testing.T) {
	t.Parallel()
	secret := []byte("12345678901234567890")
	for unix, want := range map[int64]string{
		59: "287082", 1111111109: "081804", 1111111111: "050471",
		1234567890: "005924", 2000000000: "279037", 20000000000: "353130",
	} {
		if got := hotp(secret, totpCounter(time.Unix(unix, 0))); got != want {
			t.Errorf("T=%d: code %s, want %s", unix, got, want)
		}
	}
}

func TestTOTPAcceptsOneStepOfClockSkewAndNoMore(t *testing.T) {
	t.Parallel()
	secret := []byte("12345678901234567890")
	now := time.Unix(1_800_000_000, 0)
	for offset, ok := range map[time.Duration]bool{0: true, -30 * time.Second: true, 30 * time.Second: true, -60 * time.Second: false, 90 * time.Second: false} {
		code := hotp(secret, totpCounter(now.Add(offset)))
		if _, got := verifyTOTP(secret, code, now); got != ok {
			t.Errorf("code from %v away: accepted = %v, want %v", offset, got, ok)
		}
	}
	if _, ok := verifyTOTP(secret, "12345", now); ok {
		t.Error("a 5-digit code was accepted")
	}
}

func TestEnrolmentURIMatchesTheConsoleFormat(t *testing.T) {
	t.Parallel()
	uri := otpauthURI([]byte("12345678901234567890"), "aisha@nem.bank")
	for _, part := range []string{"otpauth://totp/Nem%20Console:aisha@nem.bank?", "secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "issuer=Nem+Console", "period=30", "digits=6"} { // gitleaks:allow (RFC 6238 test secret)
		if !strings.Contains(uri, part) {
			t.Errorf("%s lacks %q", uri, part)
		}
	}
}
