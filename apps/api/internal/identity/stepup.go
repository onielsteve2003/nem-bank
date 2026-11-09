package identity

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity/identitydb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// Step-up: fresh proof before a sensitive action (risky transfer, card reveal, PIN reset,
// unfreeze, ...). It follows the app's mock bank (apps/mobile/src/data/mock/domains/auth.ts)
// so the screens work against either: any one listed method passes, and the token lasts
// 5 minutes, works once and only for the purpose it was started for.
//
// A step-up is an otp_challenges row with purpose step_up, so its step_up_id is also the
// email code's challenge_id: the app's "send again" goes through POST /v1/auth/otp/resend.

// stepUpsPerHour caps step-ups per customer. Each one emails a code, so this also bounds
// the mail a stolen session can send to the customer.
const stepUpsPerHour = 10

// Step-up problems. Codes and wording match the mock bank.
var (
	ErrStepUpExpired    = problem.New(http.StatusGone, "otp_expired", "This check has expired. Start again.")
	ErrStepUpNoProof    = problem.Validation(problem.Field("/", "required", "Enter your PIN or the code we sent"))
	ErrWrongPin         = problem.New(http.StatusUnprocessableEntity, "invalid_pin", "Wrong PIN")
	ErrStepUpPinLocked  = problem.New(http.StatusLocked, "pin_locked", "Wrong PIN")
	ErrInvalidSignature = problem.New(http.StatusUnauthorized, "invalid_signature", "Use your PIN instead")
	ErrInvalidAnswer    = problem.New(http.StatusUnprocessableEntity, "invalid_answer", "That answer is not right")
)

// StepUp is a started step-up as the client sees it.
type StepUp struct {
	ID        uuid.UUID
	Purpose   string
	Methods   []string
	Challenge Challenge
	ExpiresAt time.Time
}

// StepUpProof is what the customer gives; exactly one field is expected.
type StepUpProof struct {
	OTPCode, Pin, Signature, SecurityAnswer *string
}

// StepUpToken is a passed step-up.
type StepUpToken struct {
	Token     string
	Purpose   string
	ExpiresAt time.Time
}

// StartStepUp emails a code and lists the ways to pass. The code goes out even when the
// customer will use their PIN or Face ID: the screens show the code entry at once.
func (s *Service) StartStepUp(ctx context.Context, purpose string) (StepUp, error) {
	p, err := principal(ctx)
	if err != nil {
		return StepUp{}, err
	}
	user, err := s.q.GetUser(ctx, p.UserID)
	if err != nil {
		return StepUp{}, fmt.Errorf("load user: %w", err)
	}
	var c identitydb.OtpChallenge
	var code string
	err = s.inTx(ctx, func(q *identitydb.Queries) error {
		recent, err := q.RecentStepUpsFor(ctx, identitydb.RecentStepUpsForParams{
			SubjectID: user.ID, Since: s.now().Add(-time.Hour),
		})
		if err != nil {
			return fmt.Errorf("count recent step-ups: %w", err)
		}
		if recent.N >= stepUpsPerHour {
			return ErrTooManyCodes.WithRetryAt(recent.Oldest.Add(time.Hour))
		}
		c, code, err = s.createChallenge(ctx, q, PurposeStepUp, user.ID, user.Email, &purpose)
		return err
	})
	if err != nil {
		return StepUp{}, err
	}
	if err := s.sendCode(ctx, c, code); err != nil {
		return StepUp{}, err
	}
	// The mock's list. Security questions join it once customers can set one.
	methods := []string{"email_otp"}
	if user.PinHash != nil {
		methods = []string{"pin", "email_otp"}
	}
	return StepUp{ID: c.ID, Purpose: purpose, Methods: methods, Challenge: challengeOf(c), ExpiresAt: c.ExpiresAt}, nil
}

// VerifyStepUp checks one proof and returns the step-up token.
func (s *Service) VerifyStepUp(ctx context.Context, id uuid.UUID, proof StepUpProof) (StepUpToken, error) {
	p, err := principal(ctx)
	if err != nil {
		return StepUpToken{}, err
	}
	c, err := s.q.GetChallenge(ctx, id)
	// Someone else's step-up looks the same as a missing one.
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (c.Purpose != string(PurposeStepUp) || c.SubjectID != p.UserID)) {
		return StepUpToken{}, ErrStepUpExpired
	}
	if err != nil {
		return StepUpToken{}, fmt.Errorf("load step-up: %w", err)
	}
	if c.VerifiedAt != nil || !s.now().Before(c.ExpiresAt) {
		return StepUpToken{}, ErrStepUpExpired
	}

	var v Verified
	switch {
	case proof.OTPCode != nil:
		// Same rules as every code: 5 attempts, invalid_otp with the attempts left.
		if v, err = s.VerifyCode(ctx, id, *proof.OTPCode); err != nil {
			return StepUpToken{}, err
		}
	case proof.Pin != nil:
		r, err := s.VerifyPin(ctx, *proof.Pin)
		switch {
		case err != nil:
			return StepUpToken{}, err
		case r.LockedUntil != nil:
			return StepUpToken{}, ErrStepUpPinLocked.WithRetryAt(*r.LockedUntil).WithDetailf(
				"Too many wrong PINs. Try again in %s.", FormatLockoutWait(r.LockedUntil.Sub(s.now())))
		case !r.Valid:
			return StepUpToken{}, ErrWrongPin.WithDetailf("%d attempts left.", r.AttemptsLeft)
		}
		if v, err = s.passStepUp(ctx, id); err != nil {
			return StepUpToken{}, err
		}
	case proof.Signature != nil:
		if err := s.checkDeviceSignature(ctx, p, id.String(), *proof.Signature); err != nil {
			return StepUpToken{}, err
		}
		if v, err = s.passStepUp(ctx, id); err != nil {
			return StepUpToken{}, err
		}
	case proof.SecurityAnswer != nil:
		// Nobody can set a security question yet (PUT /v1/security/question), so no answer
		// can be right; this is the mock's answer for a customer without one.
		return StepUpToken{}, ErrInvalidAnswer
	default:
		return StepUpToken{}, ErrStepUpNoProof
	}
	return StepUpToken{Token: v.Token, Purpose: deref(c.StepUpPurpose), ExpiresAt: v.ExpiresAt}, nil
}

// passStepUp marks a step-up passed by PIN or signature. The row lock and the verified
// check stop two proofs racing to earn two tokens.
func (s *Service) passStepUp(ctx context.Context, id uuid.UUID) (Verified, error) {
	var v Verified
	err := s.inTx(ctx, func(q *identitydb.Queries) error {
		c, err := q.GetChallengeForUpdate(ctx, id)
		if err != nil {
			return fmt.Errorf("lock step-up: %w", err)
		}
		if c.VerifiedAt != nil || !s.now().Before(c.ExpiresAt) {
			return ErrStepUpExpired
		}
		v, err = s.markVerified(ctx, q, c)
		return err
	})
	return v, err
}

// checkDeviceSignature verifies an Ed25519 signature by the caller's own bound device.
// The app signs the UTF-8 message with the key behind Face ID and sends base64url
// (apps/mobile/src/lib/deviceKey.ts, signWithDeviceKey).
func (s *Service) checkDeviceSignature(ctx context.Context, p Principal, message, signature string) error {
	sig, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return ErrInvalidSignature
	}
	d, err := s.q.GetLiveDevice(ctx, identitydb.GetLiveDeviceParams{ID: p.DeviceID, UserID: p.UserID})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrInvalidSignature
	}
	if err != nil {
		return fmt.Errorf("load device: %w", err)
	}
	if !ed25519.Verify(ed25519.PublicKey(d.PublicKey), []byte(message), sig) {
		return ErrInvalidSignature
	}
	return nil
}

// FormatLockoutWait says how long a lockout has left in its largest whole unit, rounding
// up: "1 minute", "30 minutes", "2 hours", "1 day". A port of formatLockoutWait in
// packages/shared/src/pin.ts, so the API's wording matches the app's.
func FormatLockoutWait(d time.Duration) string {
	unit := func(n int, word string) string {
		if n == 1 {
			return "1 " + word
		}
		return fmt.Sprintf("%d %ss", n, word)
	}
	ceil := func(d, u time.Duration) int { return int((d + u - 1) / u) }
	switch {
	case d >= longestLockout:
		return unit(ceil(d, longestLockout), "day")
	case d >= time.Hour:
		return unit(ceil(d, time.Hour), "hour")
	default:
		return unit(max(1, ceil(d, time.Minute)), "minute")
	}
}
