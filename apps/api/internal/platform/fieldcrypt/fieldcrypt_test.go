package fieldcrypt

import (
	"bytes"
	"errors"
	"testing"
)

func key(b byte) []byte { return bytes.Repeat([]byte{b}, KeySize) }

func ring(t *testing.T, versions ...uint16) *Keyring {
	t.Helper()
	keys := map[uint16][]byte{}
	for _, v := range versions {
		keys[v] = key(byte(v))
	}
	k, err := New(keys, key(0xEE))
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func TestRoundTripIsBoundToItsRowAndColumn(t *testing.T) {
	t.Parallel()
	k := ring(t, 1)
	aad := []byte("kyc_identifiers.bvn:user-1")
	ct, err := k.Encrypt([]byte("22212345678"), aad)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(ct, []byte("22212345678")) {
		t.Fatal("plaintext visible in ciphertext")
	}
	plain, err := k.Decrypt(ct, aad)
	if err != nil || string(plain) != "22212345678" {
		t.Fatalf("decrypt = %q, %v", plain, err)
	}
	again, _ := k.Encrypt([]byte("22212345678"), aad)
	if bytes.Equal(ct, again) {
		t.Fatal("two encryptions of one value are identical: nonce reuse")
	}

	flipped := append([]byte(nil), ct...)
	flipped[len(flipped)-1] ^= 1
	versioned := append([]byte(nil), ct...)
	versioned[2] = 9
	for name, tc := range map[string]struct {
		ct, aad []byte
	}{
		"another customer's row": {ct, []byte("kyc_identifiers.bvn:user-2")},
		"another column":         {ct, []byte("kyc_identifiers.nin:user-1")},
		"tampered":               {flipped, aad},
		"version byte edited":    {versioned, aad},
		"truncated":              {ct[:10], aad},
		"empty":                  {nil, aad},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := k.Decrypt(tc.ct, tc.aad); !errors.Is(err, ErrDecrypt) {
				t.Fatalf("err = %v, want ErrDecrypt", err)
			}
		})
	}
}

func TestKeysRotateWithoutBreakingOldRows(t *testing.T) {
	t.Parallel()
	aad := []byte("kyc_identifiers.nin:user-1")
	old := ring(t, 1)
	ct, _ := old.Encrypt([]byte("12345678901"), aad)

	rotated := ring(t, 1, 2)
	if rotated.Current() != 2 {
		t.Fatalf("current = %d, want the highest version", rotated.Current())
	}
	if plain, err := rotated.Decrypt(ct, aad); err != nil || string(plain) != "12345678901" {
		t.Fatalf("old row after rotation: %q, %v", plain, err)
	}
	if !rotated.NeedsRewrap(ct) {
		t.Fatal("v1 row not flagged for rewrap")
	}
	fresh, err := rotated.Rewrap(ct, aad)
	if err != nil {
		t.Fatal(err)
	}
	if v, _ := Version(fresh); v != 2 || rotated.NeedsRewrap(fresh) {
		t.Fatalf("rewrapped version = %d", v)
	}
	// Once v1 is retired, only rewrapped rows open.
	retired := ring(t, 2)
	if _, err := retired.Decrypt(ct, aad); !errors.Is(err, ErrDecrypt) {
		t.Fatal("a retired key still decrypts")
	}
	if _, err := retired.Decrypt(fresh, aad); err != nil {
		t.Fatal(err)
	}
	// The blind index does not depend on the encryption keys.
	if !bytes.Equal(old.BlindIndex("bvn", []byte("1")), retired.BlindIndex("bvn", []byte("1"))) {
		t.Fatal("blind index changed with rotation")
	}
}

func TestBlindIndexesAreSeparatedByDomainAndKey(t *testing.T) {
	t.Parallel()
	k := ring(t, 1)
	bvn := k.BlindIndex("bvn", []byte("22212345678"))
	if !bytes.Equal(bvn, k.BlindIndex("bvn", []byte("22212345678"))) {
		t.Fatal("not deterministic")
	}
	if bytes.Equal(bvn, k.BlindIndex("nin", []byte("22212345678"))) {
		t.Fatal("the same number gives the same index for BVN and NIN")
	}
	other, _ := New(map[uint16][]byte{1: key(1)}, key(0xDD))
	if bytes.Equal(bvn, other.BlindIndex("bvn", []byte("22212345678"))) {
		t.Fatal("index does not depend on the index key")
	}
}

func TestBadKeyringsAreRefused(t *testing.T) {
	t.Parallel()
	for name, keys := range map[string]map[uint16][]byte{
		"none":      {},
		"short key": {1: key(1)[:16]},
		"version 0": {0: key(1)},
	} {
		if _, err := New(keys, key(0xEE)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := New(map[uint16][]byte{1: key(1)}, []byte("short")); err == nil {
		t.Error("short index key accepted")
	}
}
