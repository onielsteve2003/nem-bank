package partners

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestCallbackSignatures(t *testing.T) {
	t.Parallel()
	secret := []byte("callback-secret")
	body := []byte(`{"event_type":"transfer.settled","reference":"NEM20261109AAAAAA"}`)
	at := time.Unix(1_762_700_000, 0)
	good := Sign(secret, at, body)

	if err := Verify(secret, good, body, at.Add(time.Minute)); err != nil {
		t.Fatalf("a fresh, correct signature: %v", err)
	}
	// During a secret rotation the partner sends both MACs; either is enough.
	rotated := good + ",v1=" + strings.Repeat("0", 64)
	if err := Verify(secret, rotated, body, at); err != nil {
		t.Fatalf("rotation header: %v", err)
	}

	for name, tc := range map[string]struct {
		secret []byte
		header string
		body   []byte
		now    time.Time
	}{
		"wrong secret":      {[]byte("other"), good, body, at},
		"body changed":      {secret, good, []byte(`{"event_type":"transfer.failed"}`), at},
		"too old":           {secret, good, body, at.Add(SignatureTolerance + time.Second)},
		"from the future":   {secret, good, body, at.Add(-SignatureTolerance - time.Second)},
		"time swapped":      {secret, strings.Replace(good, "t=1762700000", "t=1762700001", 1), body, at},
		"no signature":      {secret, "t=1762700000", body, at},
		"no timestamp":      {secret, "v1=" + strings.SplitN(good, "v1=", 2)[1], body, at},
		"empty header":      {secret, "", body, at},
		"no secret to test": {nil, good, body, at},
	} {
		if err := Verify(tc.secret, tc.header, tc.body, tc.now); !errors.Is(err, ErrBadSignature) {
			t.Errorf("%s: %v, want ErrBadSignature", name, err)
		}
	}
}
