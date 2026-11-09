package kyc

import (
	"bytes"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/fieldcrypt"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

func keyring(t *testing.T, versions ...uint16) *fieldcrypt.Keyring {
	t.Helper()
	keys := map[uint16][]byte{}
	for _, v := range versions {
		keys[v] = bytes.Repeat([]byte{byte(v)}, fieldcrypt.KeySize)
	}
	k, err := fieldcrypt.New(keys, bytes.Repeat([]byte{0xEE}, 32))
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func customer(t *testing.T, pool *pgxpool.Pool, n int) uuid.UUID {
	t.Helper()
	id := uuid.Must(uuid.NewV7())
	_, err := pool.Exec(t.Context(), `INSERT INTO users (id, first_name, last_name, email, phone, date_of_birth,
		password_hash, terms_version, privacy_version, consent_accepted_at)
		VALUES ($1, 'Tolu', 'Adeyemi', $2, $3, '1996-04-12', 'x', '2026-10', '2026-10', now())`,
		id, "tolu"+string(rune('a'+n))+"@example.com", "+23480312345"+string(rune('0'+n))+"0")
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestNumbersAreStoredEncryptedAndOneBVNHasOneOwner(t *testing.T) {
	t.Parallel()
	pool := testdb.New(t)
	ctx := t.Context()
	ids := NewIdentifiers(keyring(t, 1))
	tolu, emeka := customer(t, pool, 1), customer(t, pool, 2)

	if err := ids.Save(ctx, pool, tolu, BVN, "222 1234 5678"); err != nil {
		t.Fatal(err)
	}
	var stored []byte
	if err := pool.QueryRow(ctx, `SELECT ciphertext FROM kyc_identifiers WHERE user_id = $1`, tolu).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(stored, []byte("22212345678")) {
		t.Fatal("the BVN is in the database in plain text")
	}
	if got, err := ids.Reveal(ctx, pool, tolu, BVN); err != nil || got != "22212345678" {
		t.Fatalf("reveal = %q, %v", got, err)
	}
	if last4, _ := ids.Last4(ctx, pool, tolu, BVN); last4 != "5678" {
		t.Fatalf("last4 = %q", last4)
	}

	if err := ids.Save(ctx, pool, emeka, BVN, "22212345678"); !errors.Is(err, ErrIdentifierInUse) {
		t.Fatalf("second owner of a BVN: %v", err)
	}
	// The same 11 digits as a NIN are a different identifier.
	if err := ids.Save(ctx, pool, emeka, NIN, "22212345678"); err != nil {
		t.Fatalf("NIN equal to someone's BVN: %v", err)
	}
	if err := ids.Save(ctx, pool, tolu, IDDocument, "a01234567"); err != nil {
		t.Fatal(err)
	}
	if got, _ := ids.Reveal(ctx, pool, tolu, IDDocument); got != "A01234567" {
		t.Fatalf("document = %q", got)
	}
	for _, bad := range []struct {
		kind Kind
		v    string
	}{{BVN, "2221234567"}, {NIN, "2221234567X"}, {IDDocument, "AB1"}, {IDDocument, "A0123-4567"}} {
		var p *problem.Error
		if err := ids.Save(ctx, pool, tolu, bad.kind, bad.v); !errors.As(err, &p) || p.Code != "validation_failed" {
			t.Errorf("%s %q: %v", bad.kind, bad.v, err)
		}
	}

	// A ciphertext copied onto another customer's row does not decrypt.
	if _, err := pool.Exec(ctx, `UPDATE kyc_identifiers SET ciphertext = $1 WHERE user_id = $2 AND kind = 'nin'`, stored, emeka); err != nil {
		t.Fatal(err)
	}
	if _, err := ids.Reveal(ctx, pool, emeka, NIN); !errors.Is(err, fieldcrypt.ErrDecrypt) {
		t.Fatalf("moved ciphertext: %v", err)
	}
	if _, err := ids.Reveal(ctx, pool, emeka, BVN); !errors.Is(err, ErrNoIdentifier) {
		t.Fatalf("missing: %v", err)
	}
}

func TestRotationRewrapsEveryRowOntoTheNewKey(t *testing.T) {
	t.Parallel()
	pool := testdb.New(t)
	ctx := t.Context()
	tolu, emeka := customer(t, pool, 1), customer(t, pool, 2)
	v1 := NewIdentifiers(keyring(t, 1))
	_ = v1.Save(ctx, pool, tolu, BVN, "22212345678")
	_ = v1.Save(ctx, pool, emeka, BVN, "22287654321")

	v2 := NewIdentifiers(keyring(t, 1, 2))
	if n, err := v2.Rewrap(ctx, pool, 1); err != nil || n != 1 {
		t.Fatalf("first batch = %d, %v", n, err)
	}
	if n, err := v2.Rewrap(ctx, pool, 10); err != nil || n != 1 {
		t.Fatalf("second batch = %d, %v", n, err)
	}
	if n, _ := v2.Rewrap(ctx, pool, 10); n != 0 {
		t.Fatalf("nothing left, moved %d", n)
	}
	// With v1 retired, every row still opens, and the uniqueness check still works.
	v2only := NewIdentifiers(keyring(t, 2))
	if got, err := v2only.Reveal(ctx, pool, emeka, BVN); err != nil || got != "22287654321" {
		t.Fatalf("after retiring v1: %q, %v", got, err)
	}
	if err := v2only.Save(ctx, pool, emeka, BVN, "22212345678"); !errors.Is(err, ErrIdentifierInUse) {
		t.Fatalf("uniqueness after rotation: %v", err)
	}
}
