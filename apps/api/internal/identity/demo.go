package identity

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity/identitydb"
)

// DemoUser is the persona a demo session starts as (AUTH-11).
type DemoUser struct {
	FirstName, LastName string
	// NemtagBase is the start of the @nemtag; a random suffix makes it unique.
	NemtagBase  string
	DateOfBirth time.Time
	KycTier     int16
	KycStatus   string
	// Pin is the transaction PIN the demo user confirms payments with.
	Pin string
}

// demoTries bounds the retries when a random email, phone or tag is already taken.
const demoTries = 5

// StartDemo creates a fresh demo customer and opens a session for it on the caller's device.
// The customer is flagged is_demo, which is what lets the demo operations act on it, and has
// no password anyone could know. seed runs in the same transaction, after the customer's
// account exists, to put the persona's history in place; any failure leaves nothing behind.
func (s *Service) StartDemo(ctx context.Context, u DemoUser, device DeviceRegistration, seed func(ctx context.Context, tx pgx.Tx, userID uuid.UUID) error) (AuthResult, error) {
	pinHash, err := s.hasher.Hash(ctx, u.Pin)
	if err != nil {
		return AuthResult{}, err
	}
	var lastErr error
	for range demoTries {
		var out AuthResult
		lastErr = s.inTxWith(ctx, func(tx pgx.Tx, q *identitydb.Queries) error {
			var err error
			out, err = s.createDemo(ctx, tx, q, u, pinHash, device, seed)
			return err
		})
		if lastErr == nil {
			return out, nil
		}
		switch uniqueViolation(lastErr) {
		case "users_email_key", "users_phone_key", "users_nemtag_key":
			continue
		}
		return AuthResult{}, unwrapTx(lastErr)
	}
	return AuthResult{}, fmt.Errorf("demo user: %w", lastErr)
}

// unwrapTx returns the error inside inTxWith's wrapper, so a problem keeps its status.
func unwrapTx(err error) error {
	if inner := errors.Unwrap(err); inner != nil {
		return inner
	}
	return err
}

func (s *Service) createDemo(ctx context.Context, tx pgx.Tx, q *identitydb.Queries, u DemoUser, pinHash string, device DeviceRegistration, seed func(ctx context.Context, tx pgx.Tx, userID uuid.UUID) error) (AuthResult, error) {
	id, err := newID()
	if err != nil {
		return AuthResult{}, err
	}
	suffix, err := randomDigits(4)
	if err != nil {
		return AuthResult{}, err
	}
	phone, err := demoPhone()
	if err != nil {
		return AuthResult{}, err
	}
	now := s.now()
	user, err := q.InsertUser(ctx, identitydb.InsertUserParams{
		ID: id, FirstName: u.FirstName, LastName: u.LastName,
		// The .invalid domain is reserved (RFC 6761), so a demo address can never receive mail.
		Email: "demo-" + id.String()[24:] + "@demo.nembank.invalid", Phone: phone,
		DateOfBirth: u.DateOfBirth, PasswordHash: "!demo", TermsVersion: "demo", PrivacyVersion: "demo",
		ConsentAcceptedAt: now,
	})
	if err != nil {
		return AuthResult{}, fmt.Errorf("insert demo user: %w", err)
	}
	status := u.KycStatus
	if status == "" {
		status = "not_started"
	}
	tag := u.NemtagBase + "_" + suffix
	if _, err := tx.Exec(ctx,
		`UPDATE users SET is_demo = true, kyc_tier = $2, kyc_status = $3, nemtag = $4, pin_hash = $5 WHERE id = $1`,
		id, u.KycTier, status, tag, pinHash); err != nil {
		return AuthResult{}, fmt.Errorf("flag demo user: %w", err)
	}
	user.KycTier, user.KycStatus, user.IsDemo = u.KycTier, status, true
	user.Nemtag, user.PinHash = &tag, &pinHash
	if s.onCustomerCreated != nil {
		if err := s.onCustomerCreated(ctx, tx, NewCustomer{UserID: id, Name: u.FirstName + " " + u.LastName}); err != nil {
			return AuthResult{}, fmt.Errorf("set up demo customer: %w", err)
		}
	}
	if seed != nil {
		if err := seed(ctx, tx, id); err != nil {
			return AuthResult{}, fmt.Errorf("seed demo customer: %w", err)
		}
	}
	if err := s.releaseDemoDevice(ctx, tx, device.PublicKey); err != nil {
		return AuthResult{}, err
	}
	d, err := s.bindDevice(ctx, tx, q, id, device, false)
	if err != nil {
		return AuthResult{}, err
	}
	return s.openSession(ctx, q, user, d)
}

// releaseDemoDevice ends an earlier demo customer's use of this device key. A phone has one
// key, so tapping "Try the demo" again (after signing out) must not be refused because the
// last throwaway customer still holds it. A key on a real customer's account is left alone,
// and bindDevice then refuses it as usual.
func (s *Service) releaseDemoDevice(ctx context.Context, tx pgx.Tx, publicKey string) error {
	pub, err := base64.RawURLEncoding.DecodeString(publicKey)
	if err != nil || len(pub) != 32 {
		return nil // bindDevice reports the bad key
	}
	if _, err := tx.Exec(ctx, `
		UPDATE sessions SET revoked_at = now(), revoke_reason = 'replaced'
		WHERE revoked_at IS NULL AND device_id IN (
		  SELECT d.id FROM devices d JOIN users u ON u.id = d.user_id
		  WHERE d.public_key = $1 AND d.revoked_at IS NULL AND u.is_demo)`, pub); err != nil {
		return fmt.Errorf("end earlier demo sessions: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE devices SET revoked_at = now()
		WHERE public_key = $1 AND revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE is_demo)`, pub); err != nil {
		return fmt.Errorf("release earlier demo device: %w", err)
	}
	return nil
}

// randomDigits returns n random decimal digits.
func randomDigits(n int) (string, error) {
	out := make([]byte, n)
	for i := range out {
		v, err := rand.Int(rand.Reader, big.NewInt(10))
		if err != nil {
			return "", fmt.Errorf("random digits: %w", err)
		}
		out[i] = byte('0' + int(v.Int64())%10)
	}
	return string(out), nil
}

// demoPhone is a random Nigerian mobile number in the stored form (+234, a 7/8/9 network
// digit, 0 or 1, then 8 digits).
func demoPhone() (string, error) {
	head, err := rand.Int(rand.Reader, big.NewInt(3))
	if err != nil {
		return "", fmt.Errorf("random phone: %w", err)
	}
	second, err := randomDigits(1)
	if err != nil {
		return "", err
	}
	if second[0] > '1' {
		second = string(byte('0' + (second[0]-'0')%2))
	}
	rest, err := randomDigits(8)
	if err != nil {
		return "", err
	}
	return "+234" + string(rune('7'+int(head.Int64())%3)) + second + rest, nil
}
