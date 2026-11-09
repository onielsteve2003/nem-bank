package identity

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity/identitydb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// Device binding (AUTH-6, ADR-9). Every money-moving request carries an Ed25519 signature
// by the device key the customer bound at sign-up or login. A stolen access token alone
// cannot move money: the private key never leaves the phone and is unlocked by Face ID.

const (
	// signatureWindow is how far a signed timestamp may be from server time, either way.
	signatureWindow = 5 * time.Minute
	// deviceChallengeTTL is how long the phone has to answer a quick-login challenge.
	deviceChallengeTTL = 2 * time.Minute
)

// Signature problems. A bad request signature is a 403, not a 401: the session is fine,
// and the app refreshes its token and retries on any 401, which would ask for Face ID twice.
var (
	ErrRequestSignature = problem.New(http.StatusForbidden, "invalid_signature", "This request could not be verified").
				WithDetail("Approve it again on this phone.")
	ErrSignatureStale = problem.New(http.StatusForbidden, "invalid_signature", "This request could not be verified").
				WithDetail("Check that your phone's date and time are set automatically, then try again.")
	ErrSignatureReplayed = problem.New(http.StatusForbidden, "invalid_signature", "This request was already sent").
				WithDetail("Start again to send a new one.")
	ErrDeviceLogin   = problem.New(http.StatusUnauthorized, "invalid_signature", "Sign in with your password instead")
	ErrDeviceUnknown = problem.New(http.StatusNotFound, problem.CodeNotFound, "This device is not bound to an account")
)

// SignedRequest is what a device signed, exactly as it arrived: the timestamp is the raw
// header text and the body the raw bytes, because the signature covers those.
type SignedRequest struct {
	DeviceID  uuid.UUID
	Signature string
	Timestamp string
	Nonce     string
	Method    string
	// Target is the path plus any query string, as sent ("/v1/transfers?x=1").
	Target string
	Body   []byte
}

// CanonicalPayload is the text a request signature covers:
// METHOD\ntarget\ntimestamp\nnonce\nhex(sha256(body)). The app builds the same string
// in signingPayload (apps/mobile/src/lib/deviceKey.ts).
func CanonicalPayload(r SignedRequest) string {
	sum := sha256.Sum256(r.Body)
	return strings.Join([]string{
		strings.ToUpper(r.Method), r.Target, r.Timestamp, r.Nonce, hex.EncodeToString(sum[:]),
	}, "\n")
}

// VerifyRequestSignature checks a money-moving request: signed by the device of the
// caller's own session, inside the time window, and never seen before. The nonce is only
// recorded once the signature is good, so nobody can burn another device's nonces.
func (s *Service) VerifyRequestSignature(ctx context.Context, r SignedRequest) error {
	p, err := principal(ctx)
	if err != nil {
		return err
	}
	// The session was opened on one device; another device's key, even the same
	// customer's, does not vouch for this token.
	if r.DeviceID != p.DeviceID {
		return ErrRequestSignature
	}
	signedAt, err := time.Parse(time.RFC3339Nano, r.Timestamp)
	if err != nil {
		return ErrSignatureStale
	}
	now := s.now()
	if d := now.Sub(signedAt); d > signatureWindow || d < -signatureWindow {
		return ErrSignatureStale
	}
	sig, err := base64.RawURLEncoding.DecodeString(r.Signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return ErrRequestSignature
	}
	d, err := s.q.GetLiveDevice(ctx, identitydb.GetLiveDeviceParams{ID: p.DeviceID, UserID: p.UserID})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrRequestSignature
	}
	if err != nil {
		return fmt.Errorf("load device: %w", err)
	}
	if !ed25519.Verify(ed25519.PublicKey(d.PublicKey), []byte(CanonicalPayload(r)), sig) {
		return ErrRequestSignature
	}

	return s.inTx(ctx, func(q *identitydb.Queries) error {
		if err := q.PruneDeviceNonces(ctx, identitydb.PruneDeviceNoncesParams{DeviceID: d.ID, Before: now}); err != nil {
			return fmt.Errorf("prune nonces: %w", err)
		}
		// Kept until the timestamp leaves the window; from then on the window refuses it.
		n, err := q.InsertNonce(ctx, identitydb.InsertNonceParams{
			DeviceID: d.ID, Nonce: r.Nonce, ExpiresAt: signedAt.Add(signatureWindow),
		})
		if err != nil {
			return fmt.Errorf("record nonce: %w", err)
		}
		if n == 0 {
			return ErrSignatureReplayed
		}
		return nil
	})
}

// DeviceChallenge is a quick-login challenge for the phone to sign.
type DeviceChallenge struct {
	ID        uuid.UUID
	Nonce     string
	ExpiresAt time.Time
}

// CreateDeviceChallenge starts a biometric quick login on a bound device.
func (s *Service) CreateDeviceChallenge(ctx context.Context, deviceID uuid.UUID) (DeviceChallenge, error) {
	d, err := s.q.GetLiveDeviceByID(ctx, deviceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return DeviceChallenge{}, ErrDeviceUnknown
	}
	if err != nil {
		return DeviceChallenge{}, fmt.Errorf("load device: %w", err)
	}
	id, err := newID()
	if err != nil {
		return DeviceChallenge{}, err
	}
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return DeviceChallenge{}, fmt.Errorf("challenge nonce: %w", err)
	}
	now := s.now()
	var c identitydb.DeviceChallenge
	err = s.inTx(ctx, func(q *identitydb.Queries) error {
		if err := q.PruneDeviceChallenges(ctx, identitydb.PruneDeviceChallengesParams{DeviceID: d.ID, Before: now}); err != nil {
			return fmt.Errorf("prune challenges: %w", err)
		}
		c, err = q.InsertDeviceChallenge(ctx, identitydb.InsertDeviceChallengeParams{
			ID: id, DeviceID: d.ID, Nonce: hex.EncodeToString(raw), ExpiresAt: now.Add(deviceChallengeTTL),
		})
		if err != nil {
			return fmt.Errorf("insert challenge: %w", err)
		}
		return nil
	})
	if err != nil {
		return DeviceChallenge{}, err
	}
	return DeviceChallenge{ID: c.ID, Nonce: c.Nonce, ExpiresAt: c.ExpiresAt}, nil
}

// LoginWithDevice opens a session when the device signed its challenge's nonce. A
// challenge gets one attempt: a wrong signature spends it too, and that sticks.
func (s *Service) LoginWithDevice(ctx context.Context, deviceID, challengeID uuid.UUID, signature string) (AuthResult, error) {
	var out AuthResult
	var failed bool
	err := s.inTx(ctx, func(q *identitydb.Queries) error {
		c, err := q.GetDeviceChallengeForUpdate(ctx, challengeID)
		if errors.Is(err, pgx.ErrNoRows) {
			failed = true
			return nil
		}
		if err != nil {
			return fmt.Errorf("lock challenge: %w", err)
		}
		if c.DeviceID != deviceID || c.UsedAt != nil || !s.now().Before(c.ExpiresAt) {
			failed = true
			return nil
		}
		if err := q.UseDeviceChallenge(ctx, c.ID); err != nil {
			return fmt.Errorf("spend challenge: %w", err)
		}
		d, err := q.GetLiveDeviceByID(ctx, deviceID)
		if errors.Is(err, pgx.ErrNoRows) {
			failed = true
			return nil
		}
		if err != nil {
			return fmt.Errorf("load device: %w", err)
		}
		sig, err := base64.RawURLEncoding.DecodeString(signature)
		if err != nil || len(sig) != ed25519.SignatureSize ||
			!ed25519.Verify(ed25519.PublicKey(d.PublicKey), []byte(c.Nonce), sig) {
			failed = true
			return nil // commit: the challenge stays spent
		}
		user, err := q.GetUser(ctx, d.UserID)
		if err != nil {
			return fmt.Errorf("load user: %w", err)
		}
		if d, err = q.TouchDevice(ctx, d.ID); err != nil {
			return fmt.Errorf("touch device: %w", err)
		}
		out, err = s.openSession(ctx, q, user, d)
		return err
	})
	if err != nil {
		return AuthResult{}, err
	}
	if failed {
		return AuthResult{}, ErrDeviceLogin
	}
	return out, nil
}
