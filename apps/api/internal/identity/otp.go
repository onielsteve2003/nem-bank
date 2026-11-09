package identity

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity/identitydb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/mailer"
)

// OTP rules (AUTH-2) plus the send limits that keep the free mail quota and inboxes safe.
const (
	otpTTL          = 10 * time.Minute
	otpResendAfter  = 60 * time.Second
	otpAttempts     = 5
	otpMaxSends     = 5 // per challenge, the first send included
	otpPerAddress   = 5 // new challenges per address per window
	otpAddressLimit = time.Hour
	verifiedTTL     = 15 * time.Minute // how long the verification token stays usable
)

// Purpose says what a code unlocks; a token from one purpose never works for another.
type Purpose string

// Code purposes, matching the otp_challenges CHECK constraint.
const (
	PurposeSignup        Purpose = "signup"
	PurposePasswordReset Purpose = "password_reset"
	PurposeStepUp        Purpose = "step_up"
)

// Challenge is a code that was sent, as the client sees it.
type Challenge struct {
	ID           uuid.UUID
	Destination  string
	ExpiresAt    time.Time
	ResendAt     time.Time
	AttemptsLeft int
}

// Verified is the proof a correct code earns, for the follow-up call.
type Verified struct {
	Token     string
	ExpiresAt time.Time
}

func challengeOf(c identitydb.OtpChallenge) Challenge {
	return Challenge{
		ID: c.ID, Destination: c.Destination, ExpiresAt: c.ExpiresAt,
		ResendAt: c.ResendAvailableAt, AttemptsLeft: int(c.AttemptsLeft),
	}
}

// MaskEmail shows enough of an address to recognise it: "t***@gmail.com".
func MaskEmail(email string) string {
	local, domain, ok := strings.Cut(email, "@")
	if !ok || local == "" {
		return "***"
	}
	return local[:1] + "***@" + domain
}

// newCode draws a uniform 6-digit code from crypto/rand.
func newCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", fmt.Errorf("otp code: %w", err)
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

// codeMAC binds the code to its challenge, so a stored MAC is useless for any other row.
func (s *Service) codeMAC(id uuid.UUID, code string) []byte {
	m := hmac.New(sha256.New, s.otpKey)
	m.Write(id[:])
	m.Write([]byte(code))
	return m.Sum(nil)
}

func hashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// checkAddressLimit refuses a new challenge once an address has had otpPerAddress in the
// last hour, and says when the next one is allowed.
func (s *Service) checkAddressLimit(ctx context.Context, q *identitydb.Queries, destination string) error {
	now := s.now()
	recent, err := q.RecentChallengesTo(ctx, identitydb.RecentChallengesToParams{
		Destination: destination, Since: now.Add(-otpAddressLimit),
	})
	if err != nil {
		return fmt.Errorf("count recent codes: %w", err)
	}
	if recent.N >= otpPerAddress {
		return ErrTooManyCodes.WithRetryAt(recent.Oldest.Add(otpAddressLimit))
	}
	return nil
}

// createChallenge stores a new code inside the caller's transaction and returns it with
// the plain code for sending. The caller sends only after its transaction commits.
func (s *Service) createChallenge(ctx context.Context, q *identitydb.Queries, purpose Purpose, subject uuid.UUID, destination string) (identitydb.OtpChallenge, string, error) {
	if err := s.checkAddressLimit(ctx, q, destination); err != nil {
		return identitydb.OtpChallenge{}, "", err
	}
	id, err := newID()
	if err != nil {
		return identitydb.OtpChallenge{}, "", err
	}
	code, err := newCode()
	if err != nil {
		return identitydb.OtpChallenge{}, "", err
	}
	now := s.now()
	c, err := q.InsertChallenge(ctx, identitydb.InsertChallengeParams{
		ID: id, Purpose: string(purpose), SubjectID: subject, Destination: destination,
		CodeHash: s.codeMAC(id, code), AttemptsLeft: otpAttempts,
		ExpiresAt: now.Add(otpTTL), ResendAvailableAt: now.Add(otpResendAfter),
	})
	if err != nil {
		return identitydb.OtpChallenge{}, "", fmt.Errorf("insert otp challenge: %w", err)
	}
	return c, code, nil
}

// sendCode emails the code. A failure is logged with its cause and surfaced as a 503.
func (s *Service) sendCode(ctx context.Context, c identitydb.OtpChallenge, code string) error {
	err := s.mail.Send(ctx, mailer.Message{
		To:      c.Destination,
		Subject: "Your Nem Bank code: " + code,
		Text: "Your Nem Bank code is " + code + ".\n\n" +
			"It expires in 10 minutes. Nem Bank staff will never ask you for this code.\n" +
			"If you did not ask for it, you can ignore this email.\n",
	})
	if err != nil {
		s.log.ErrorContext(ctx, "send otp email", "challenge_id", c.ID.String(), "error", err.Error())
		return ErrEmailUnavailable.WithCause(err)
	}
	return nil
}

// VerifyCode checks a code with AUTH-2's rules: 10-minute expiry and 5 attempts. A right
// code returns a single-use token for the follow-up call.
func (s *Service) VerifyCode(ctx context.Context, challengeID uuid.UUID, code string) (Verified, error) {
	var out Verified
	var wrong error
	err := s.inTx(ctx, func(q *identitydb.Queries) error {
		c, err := q.GetChallengeForUpdate(ctx, challengeID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrChallengeNotFound
		}
		if err != nil {
			return fmt.Errorf("load otp challenge: %w", err)
		}
		now := s.now()
		switch {
		case c.VerifiedAt != nil || !now.Before(c.ExpiresAt):
			return ErrOTPExpired
		case c.AttemptsLeft <= 0:
			return ErrOTPExhausted
		}
		if !hmac.Equal(s.codeMAC(c.ID, code), c.CodeHash) {
			if err := q.RecordWrongCode(ctx, c.ID); err != nil {
				return fmt.Errorf("record wrong code: %w", err)
			}
			left := c.AttemptsLeft - 1
			plural := "s"
			if left == 1 {
				plural = ""
			}
			// Returned after commit: the spent attempt must stick even though this fails.
			wrong = ErrOTPInvalid.WithDetailf("%d attempt%s left.", left, plural)
			return nil
		}
		token, err := newToken()
		if err != nil {
			return err
		}
		out = Verified{Token: token, ExpiresAt: now.Add(verifiedTTL)}
		if err := q.MarkChallengeVerified(ctx, identitydb.MarkChallengeVerifiedParams{
			ID: c.ID, TokenHash: hashToken(token), TokenExpiresAt: &out.ExpiresAt,
		}); err != nil {
			return fmt.Errorf("mark otp verified: %w", err)
		}
		return nil
	})
	if err != nil {
		return Verified{}, err
	}
	if wrong != nil {
		return Verified{}, wrong
	}
	return out, nil
}

// ResendCode sends a fresh code on the same challenge once the 60-second cooldown has
// passed. The new code replaces the old one and restores the attempts, so the total
// guesses on one challenge stay capped at otpMaxSends × otpAttempts.
func (s *Service) ResendCode(ctx context.Context, challengeID uuid.UUID) (Challenge, error) {
	var c identitydb.OtpChallenge
	var code string
	err := s.inTx(ctx, func(q *identitydb.Queries) error {
		cur, err := q.GetChallengeForUpdate(ctx, challengeID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrChallengeNotFound
		}
		if err != nil {
			return fmt.Errorf("load otp challenge: %w", err)
		}
		now := s.now()
		switch {
		case cur.VerifiedAt != nil:
			return ErrOTPExpired
		case now.Before(cur.ResendAvailableAt):
			return ErrResendTooSoon.WithRetryAt(cur.ResendAvailableAt)
		case cur.Sends >= otpMaxSends:
			return ErrTooManyCodes.WithDetail("Start again to get a new code.")
		}
		if code, err = newCode(); err != nil {
			return err
		}
		c, err = q.ResendChallenge(ctx, identitydb.ResendChallengeParams{
			ID: cur.ID, CodeHash: s.codeMAC(cur.ID, code), AttemptsLeft: otpAttempts,
			ExpiresAt: now.Add(otpTTL), ResendAvailableAt: now.Add(otpResendAfter),
		})
		if err != nil {
			return fmt.Errorf("resend otp challenge: %w", err)
		}
		return nil
	})
	if err != nil {
		return Challenge{}, err
	}
	if err := s.sendCode(ctx, c, code); err != nil {
		return Challenge{}, err
	}
	return challengeOf(c), nil
}

// consumeToken locks the challenge a verification token belongs to and marks it used, so
// the token works exactly once. It must run inside the caller's transaction.
func (s *Service) consumeToken(ctx context.Context, q *identitydb.Queries, purpose Purpose, subject uuid.UUID, token string) error {
	c, err := q.GetChallengeByTokenForUpdate(ctx, hashToken(token))
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotVerified
	}
	if err != nil {
		return fmt.Errorf("load verified challenge: %w", err)
	}
	if c.Purpose != string(purpose) || c.SubjectID != subject || c.ConsumedAt != nil ||
		c.TokenExpiresAt == nil || !s.now().Before(*c.TokenExpiresAt) {
		return ErrNotVerified
	}
	if err := q.ConsumeChallenge(ctx, c.ID); err != nil {
		return fmt.Errorf("consume challenge: %w", err)
	}
	return nil
}
