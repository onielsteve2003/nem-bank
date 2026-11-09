package admin

import (
	"crypto/hmac"
	"crypto/sha1" //nolint:gosec // RFC 6238 TOTP is HMAC-SHA1; it is what authenticator apps compute
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"time"
)

// RFC 6238 TOTP with the parameters every authenticator app expects: HMAC-SHA1, 30-second
// steps, 6 digits. The console's demo authenticator (apps/console/src/lib/totp.ts) uses the
// same ones, so a code from either side verifies on the other.
const (
	totpStep    = 30 * time.Second
	totpDigits  = 6
	totpSkew    = 1 // steps accepted either side of now, for a phone clock a little off
	totpIssuer  = "Nem Console"
	totpKeySize = 20 // 160 bits, RFC 4226's recommended secret length
)

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// hotp is RFC 4226: the dynamically truncated HMAC of the counter, as 6 digits.
func hotp(secret []byte, counter uint64) string {
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], counter)
	mac := hmac.New(sha1.New, secret)
	mac.Write(msg[:])
	sum := mac.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	bin := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	return fmt.Sprintf("%0*d", totpDigits, bin%1_000_000)
}

func totpCounter(t time.Time) uint64 {
	return uint64(t.Unix() / int64(totpStep/time.Second)) //nolint:gosec // times after 1970: never negative
}

// verifyTOTP returns the time step the code belongs to, so the caller can refuse a step
// already used. The comparison is constant time.
func verifyTOTP(secret []byte, code string, now time.Time) (uint64, bool) {
	if len(code) != totpDigits {
		return 0, false
	}
	cur := totpCounter(now)
	for _, c := range []uint64{cur, cur - totpSkew, cur + totpSkew} {
		if hmac.Equal([]byte(hotp(secret, c)), []byte(code)) {
			return c, true
		}
	}
	return 0, false
}

// otpauthURI is the enrolment link authenticator apps scan as a QR code.
func otpauthURI(secret []byte, email string) string {
	q := url.Values{}
	q.Set("secret", b32.EncodeToString(secret))
	q.Set("issuer", totpIssuer)
	q.Set("digits", "6")
	q.Set("period", "30")
	return "otpauth://totp/" + url.PathEscape(totpIssuer+":"+email) + "?" + q.Encode()
}
