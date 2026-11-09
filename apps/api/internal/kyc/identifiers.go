// Package kyc owns know-your-customer data. So far: the identity numbers (BVN, NIN, ID
// document), stored encrypted per field. Tier upgrades, the KycProvider and the review
// workflow arrive with T30.2.
package kyc

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/kyc/kycdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/fieldcrypt"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// Kind is which identity number.
type Kind string

// The kinds stored. BVN and NIN are 11 digits; a document number is a passport, driver's
// licence or voter's card number.
const (
	BVN        Kind = "bvn"
	NIN        Kind = "nin"
	IDDocument Kind = "id_document"
)

var (
	elevenDigits = regexp.MustCompile(`^[0-9]{11}$`)
	documentNo   = regexp.MustCompile(`^[A-Z0-9]{5,20}$`)
)

// Problems.
var (
	ErrIdentifierInUse = problem.New(http.StatusConflict, "identifier_in_use", "This number is linked to another Nem account").
				WithDetail("Each BVN and NIN can belong to one customer. Contact support if this is yours.")
	ErrNoIdentifier = problem.NotFound("Identity number")
)

// Identifiers stores identity numbers encrypted. Plaintext exists only in memory, for the
// KYC provider check and the step-up-gated reveal; logs and the database never see it.
type Identifiers struct {
	keys *fieldcrypt.Keyring
}

// NewIdentifiers returns the store.
func NewIdentifiers(keys *fieldcrypt.Keyring) *Identifiers { return &Identifiers{keys: keys} }

// normalize checks the number's shape: BVN and NIN are 11 digits; a document number is
// 5–20 letters and digits (passport, driver's licence, voter's card).
func normalize(kind Kind, value string) (string, error) {
	v := strings.ToUpper(strings.Join(strings.Fields(value), ""))
	ok := false
	switch kind {
	case BVN, NIN:
		ok = elevenDigits.MatchString(v)
	case IDDocument:
		ok = documentNo.MatchString(v)
	}
	if !ok {
		return "", problem.Validation(problem.Field("/"+string(kind), "bad_format", "This number is not in the expected format."))
	}
	return v, nil
}

// aad binds a ciphertext to its owner and kind, so it cannot be moved to another row.
func aad(userID uuid.UUID, kind Kind) []byte {
	return []byte("kyc_identifiers." + string(kind) + ":" + userID.String())
}

// Save encrypts and stores the customer's number, replacing any earlier one of that kind.
// A BVN or NIN already on another customer is refused.
func (s *Identifiers) Save(ctx context.Context, db kycdb.DBTX, userID uuid.UUID, kind Kind, value string) error {
	v, err := normalize(kind, value)
	if err != nil {
		return err
	}
	ct, err := s.keys.Encrypt([]byte(v), aad(userID, kind))
	if err != nil {
		return err
	}
	err = kycdb.New(db).UpsertIdentifier(ctx, kycdb.UpsertIdentifierParams{
		UserID: userID, Kind: string(kind), Ciphertext: ct, KeyVersion: int32(s.keys.Current()),
		BlindIndex: s.keys.BlindIndex(string(kind), []byte(v)), Last4: v[len(v)-4:],
	})
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "kyc_identifiers_one_owner" {
		return ErrIdentifierInUse
	}
	if err != nil {
		return fmt.Errorf("save identifier: %w", err)
	}
	return nil
}

// Last4 is what screens show ("•••• 5678"), without decrypting.
func (s *Identifiers) Last4(ctx context.Context, db kycdb.DBTX, userID uuid.UUID, kind Kind) (string, error) {
	row, err := kycdb.New(db).GetIdentifier(ctx, kycdb.GetIdentifierParams{UserID: userID, Kind: string(kind)})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNoIdentifier
	}
	if err != nil {
		return "", fmt.Errorf("load identifier: %w", err)
	}
	return row.Last4, nil
}

// Reveal decrypts the number. Callers gate it (KYC provider calls, step-up reveal).
func (s *Identifiers) Reveal(ctx context.Context, db kycdb.DBTX, userID uuid.UUID, kind Kind) (string, error) {
	row, err := kycdb.New(db).GetIdentifier(ctx, kycdb.GetIdentifierParams{UserID: userID, Kind: string(kind)})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNoIdentifier
	}
	if err != nil {
		return "", fmt.Errorf("load identifier: %w", err)
	}
	plain, err := s.keys.Decrypt(row.Ciphertext, aad(userID, kind))
	if err != nil {
		return "", fmt.Errorf("decrypt %s: %w", kind, err)
	}
	return string(plain), nil
}

// Rewrap re-encrypts up to batch rows still under an older key and returns how many it
// moved. After a key rotation, run it until it returns 0, then retire the old key.
func (s *Identifiers) Rewrap(ctx context.Context, db kycdb.DBTX, batch int32) (int, error) {
	q := kycdb.New(db)
	rows, err := q.ListIdentifiersToRewrap(ctx, kycdb.ListIdentifiersToRewrapParams{Current: int32(s.keys.Current()), N: batch})
	if err != nil {
		return 0, fmt.Errorf("list identifiers to rewrap: %w", err)
	}
	moved := 0
	for _, r := range rows {
		ct, err := s.keys.Rewrap(r.Ciphertext, aad(r.UserID, Kind(r.Kind)))
		if err != nil {
			return moved, fmt.Errorf("rewrap %s: %w", r.Kind, err)
		}
		n, err := q.RewrapIdentifier(ctx, kycdb.RewrapIdentifierParams{
			Ciphertext: ct, NewVersion: int32(s.keys.Current()), UserID: r.UserID, Kind: r.Kind, OldVersion: r.KeyVersion,
		})
		if err != nil {
			return moved, fmt.Errorf("store rewrapped %s: %w", r.Kind, err)
		}
		moved += int(n)
	}
	return moved, nil
}
