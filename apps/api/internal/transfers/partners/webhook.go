package partners

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"
)

// Partner callbacks are signed like the contract's webhooks: Partner-Signature is
// "t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">". The timestamp is inside the MAC,
// so a captured callback cannot be replayed later with a fresh time.

// SignatureTolerance is how far a callback's timestamp may be from now.
const SignatureTolerance = 5 * time.Minute

// ErrBadSignature means the callback is not from the partner, or is too old.
var ErrBadSignature = errors.New("partners: callback signature is missing, wrong or expired")

// Sign returns the Partner-Signature header for body at t.
func Sign(secret []byte, t time.Time, body []byte) string {
	ts := strconv.FormatInt(t.Unix(), 10)
	return "t=" + ts + ",v1=" + mac(secret, ts, body)
}

// Verify checks a Partner-Signature header. Several v1 values are allowed, so a partner
// can sign with an old and a new secret while one is rotated.
func Verify(secret []byte, header string, body []byte, now time.Time) error {
	var ts string
	var sigs []string
	for part := range strings.SplitSeq(header, ",") {
		k, v, _ := strings.Cut(strings.TrimSpace(part), "=")
		switch k {
		case "t":
			ts = v
		case "v1":
			sigs = append(sigs, v)
		}
	}
	sec, err := strconv.ParseInt(ts, 10, 64)
	if err != nil || len(sigs) == 0 || len(secret) == 0 {
		return ErrBadSignature
	}
	if d := now.Sub(time.Unix(sec, 0)); d > SignatureTolerance || d < -SignatureTolerance {
		return ErrBadSignature
	}
	want := mac(secret, ts, body)
	for _, s := range sigs {
		if hmac.Equal([]byte(s), []byte(want)) {
			return nil
		}
	}
	return ErrBadSignature
}

func mac(secret []byte, ts string, body []byte) string {
	h := hmac.New(sha256.New, secret)
	h.Write([]byte(ts))
	h.Write([]byte{'.'})
	h.Write(body)
	return hex.EncodeToString(h.Sum(nil))
}
