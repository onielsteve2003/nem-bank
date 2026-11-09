package identity

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity/identitydb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// signupTTL is how long a started sign-up can be finished.
const signupTTL = time.Hour

// lagos is Africa/Lagos (WAT, UTC+1, no daylight saving). A fixed zone, so the distroless
// image needs no tzdata for the age check.
var lagos = time.FixedZone("WAT", 60*60)

// SignupDetails are what a customer gives to start (AUTH-1). The contract has already
// checked shapes (E.164 phone, email format, lengths).
type SignupDetails struct {
	FirstName, LastName, Email, Phone string
	DateOfBirth                       time.Time // a calendar date
	TermsVersion, PrivacyVersion      string
	ConsentAcceptedAt                 time.Time
}

// SignupStarted is the new sign-up and the code sent for it.
type SignupStarted struct {
	SignupID  uuid.UUID
	Challenge Challenge
}

// NormalizeEmail lowercases and trims, the form every email is stored and compared in.
func NormalizeEmail(email string) string { return strings.ToLower(strings.TrimSpace(email)) }

// isAdult reports whether someone born on dob is 18 or older today in Lagos. A 29 February
// birthday comes of age on 1 March in non-leap years (time.Date normalises 29 Feb).
func isAdult(dob, now time.Time) bool {
	today := now.In(lagos)
	y, m, d := dob.Date()
	eighteenth := time.Date(y+18, m, d, 0, 0, 0, 0, lagos)
	return !eighteenth.After(today)
}

// StartSignup validates the details and emails a code. Registered emails and phones are
// refused with 409: it tells an attacker the address is a customer, but the alternative
// (a silent fake success) strands real customers who forgot they signed up, and the
// per-address code limit stops this being used to enumerate at speed.
func (s *Service) StartSignup(ctx context.Context, d SignupDetails) (SignupStarted, error) {
	d.FirstName, d.LastName = strings.TrimSpace(d.FirstName), strings.TrimSpace(d.LastName)
	d.Email = NormalizeEmail(d.Email)
	var fields []api.FieldError
	if d.FirstName == "" {
		fields = append(fields, problem.Field("/first_name", "required", "Enter your first name."))
	}
	if d.LastName == "" {
		fields = append(fields, problem.Field("/last_name", "required", "Enter your last name."))
	}
	now := s.now()
	if d.DateOfBirth.After(now) || d.DateOfBirth.Year() < now.Year()-120 {
		fields = append(fields, problem.Field("/date_of_birth", "invalid", "Enter your real date of birth."))
	} else if !isAdult(d.DateOfBirth, now) {
		return SignupStarted{}, ErrUnderage
	}
	if d.ConsentAcceptedAt.After(now.Add(5*time.Minute)) || d.TermsVersion == "" || d.PrivacyVersion == "" {
		fields = append(fields, problem.Field("/consent", "invalid", "Accept the terms and privacy notice to continue."))
	}
	if len(fields) > 0 {
		return SignupStarted{}, problem.Validation(fields...)
	}

	taken, err := s.q.EmailOrPhoneTaken(ctx, identitydb.EmailOrPhoneTakenParams{Email: d.Email, Phone: d.Phone})
	if err != nil {
		return SignupStarted{}, fmt.Errorf("check email and phone: %w", err)
	}
	if taken.EmailTaken {
		return SignupStarted{}, ErrEmailTaken
	}
	if taken.PhoneTaken {
		return SignupStarted{}, ErrPhoneTaken
	}

	signupID, err := newID()
	if err != nil {
		return SignupStarted{}, err
	}
	var c identitydb.OtpChallenge
	var code string
	err = s.inTx(ctx, func(q *identitydb.Queries) error {
		if err := q.InsertSignup(ctx, identitydb.InsertSignupParams{
			ID: signupID, FirstName: d.FirstName, LastName: d.LastName, Email: d.Email, Phone: d.Phone,
			DateOfBirth: d.DateOfBirth, TermsVersion: d.TermsVersion, PrivacyVersion: d.PrivacyVersion,
			ConsentAcceptedAt: d.ConsentAcceptedAt, ExpiresAt: now.Add(signupTTL),
		}); err != nil {
			return fmt.Errorf("insert signup: %w", err)
		}
		c, code, err = s.createChallenge(ctx, q, PurposeSignup, signupID, d.Email, nil)
		return err
	})
	if err != nil {
		return SignupStarted{}, err
	}
	if err := s.sendCode(ctx, c, code); err != nil {
		return SignupStarted{}, err
	}
	return SignupStarted{SignupID: signupID, Challenge: challengeOf(c)}, nil
}

// CompleteSignup is the last step: the verified email's token plus a password (and the
// transaction PIN, when the app sends it in the same step) turn the sign-up into an
// account, bind the first device and open a session, all in one transaction. Secrets are
// hashed first, so no row lock is held for argon2id's ~30 ms.
func (s *Service) CompleteSignup(ctx context.Context, signupID uuid.UUID, token, password, pin string, device DeviceRegistration) (AuthResult, error) {
	pending, err := s.q.GetSignup(ctx, signupID)
	if errors.Is(err, pgx.ErrNoRows) {
		return AuthResult{}, ErrNotVerified
	}
	if err != nil {
		return AuthResult{}, fmt.Errorf("load signup: %w", err)
	}
	if msg := CheckPassword(password, PasswordContext{
		FirstName: pending.FirstName, LastName: pending.LastName, Email: pending.Email,
		DateOfBirth: pending.DateOfBirth.Format(time.DateOnly),
	}); msg != "" {
		return AuthResult{}, ErrWeakPassword.WithFields(problem.Field("/password", "weak", msg))
	}
	if pin != "" && IsWeakPin(pin, pending.DateOfBirth) {
		return AuthResult{}, ErrWeakPin
	}
	hash, err := s.hasher.Hash(ctx, password)
	if err != nil {
		return AuthResult{}, err
	}
	var pinHash *string
	if pin != "" {
		h, err := s.hasher.Hash(ctx, pin)
		if err != nil {
			return AuthResult{}, err
		}
		pinHash = &h
	}
	userID, err := newID()
	if err != nil {
		return AuthResult{}, err
	}

	var out AuthResult
	err = s.inTxWith(ctx, func(tx pgx.Tx, q *identitydb.Queries) error {
		su, err := q.GetSignupForUpdate(ctx, signupID)
		if err != nil {
			return fmt.Errorf("lock signup: %w", err)
		}
		if su.CompletedAt != nil {
			return ErrNotVerified
		}
		if !s.now().Before(su.ExpiresAt) {
			return errSignupExpired
		}
		if err := s.consumeToken(ctx, q, PurposeSignup, signupID, token); err != nil {
			return err
		}
		user, err := q.InsertUser(ctx, identitydb.InsertUserParams{
			ID: userID, FirstName: su.FirstName, LastName: su.LastName, Email: su.Email, Phone: su.Phone,
			DateOfBirth: su.DateOfBirth, PasswordHash: hash, TermsVersion: su.TermsVersion,
			PrivacyVersion: su.PrivacyVersion, ConsentAcceptedAt: su.ConsentAcceptedAt,
		})
		switch uniqueViolation(err) {
		case "":
		case "users_email_key":
			// Someone finished a sign-up with this email after this one started.
			return ErrEmailTaken
		case "users_phone_key":
			return ErrPhoneTaken
		default:
			return fmt.Errorf("insert user: %w", err)
		}
		if err != nil {
			return fmt.Errorf("insert user: %w", err)
		}
		if err := q.CompleteSignup(ctx, identitydb.CompleteSignupParams{ID: signupID, UserID: &userID}); err != nil {
			return fmt.Errorf("complete signup: %w", err)
		}
		if pinHash != nil {
			if err := q.SetPinHash(ctx, identitydb.SetPinHashParams{ID: user.ID, PinHash: pinHash}); err != nil {
				return fmt.Errorf("set pin: %w", err)
			}
			user.PinHash = pinHash
		}
		d, err := s.bindDevice(ctx, tx, q, user.ID, device, false)
		if err != nil {
			return err
		}
		out, err = s.openSession(ctx, q, user, d)
		return err
	})
	if err != nil {
		return AuthResult{}, err
	}
	return out, nil
}
