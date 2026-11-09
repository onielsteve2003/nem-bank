package identity

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/audit"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity/identitydb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// PIN rules (AUTH-4), a Go port of packages/shared/src/pin.ts.
const (
	PinMaxAttempts = 5
	firstLockout   = 30 * time.Minute
	longestLockout = 24 * time.Hour
)

// PIN problems. Codes match the app's mock bank.
var (
	ErrPinExists = problem.New(http.StatusConflict, "pin_exists", "Change your PIN from Security instead")
	ErrPinNotSet = problem.New(http.StatusConflict, "invalid_state", "Set your transaction PIN first")
	ErrWeakPin   = problem.New(http.StatusUnprocessableEntity, "weak_pin", "Pick a PIN that is harder to guess").
			WithFields(problem.Field("/pin", "weak", "Pick a PIN that is harder to guess"))
	ErrPinSameAsDuress = problem.Validation(problem.Field("/pin", "same_as_duress", "Your PIN and duress PIN must be different"))
	ErrDuressSameAsPin = problem.Validation(problem.Field("/pin", "same_as_pin", "Your duress PIN must be different from your PIN"))
	ErrStepUpRequired  = problem.New(http.StatusForbidden, "step_up_required", "Confirm it is you first")
)

// PinLockout is how long the nth lockout in a row lasts: 30 minutes, then four times
// longer each time (2 h, 8 h), never more than a day. n counts from 1.
func PinLockout(n int) time.Duration {
	d := firstLockout
	for i := 1; i < n && d < longestLockout; i++ {
		d *= 4
	}
	return min(d, longestLockout)
}

// IsWeakPin refuses the PINs a thief tries first: one repeated digit (1111), straight runs
// up or down (1234, 9876), and birthday forms when the date of birth is known.
func IsWeakPin(pin string, dob time.Time) bool {
	if len(pin) == 0 {
		return true
	}
	if !dob.IsZero() && isDateOfBirthPin(pin, dob) {
		return true
	}
	same, up, down := true, true, true
	for i := 1; i < len(pin); i++ {
		step := int(pin[i]) - int(pin[i-1])
		same = same && step == 0
		up = up && step == 1
		down = down && step == -1
	}
	return same || up || down
}

// isDateOfBirthPin covers the year, day+month either way round, and 6-digit date forms.
func isDateOfBirthPin(pin string, dob time.Time) bool {
	yyyy, mm, dd := dob.Format("2006"), dob.Format("01"), dob.Format("02")
	yy := yyyy[2:]
	for _, f := range []string{yyyy, dd + mm, mm + dd, mm + yy, dd + mm + yy, mm + dd + yy, yy + mm + dd} {
		if pin == f {
			return true
		}
	}
	return false
}

// PinResult is a PIN check's outcome (contract PinVerification).
type PinResult struct {
	Valid        bool
	AttemptsLeft int
	LockedUntil  *time.Time
}

// SetPin sets the PIN the first time (sign-up sets it too). Changing it later is a reset
// behind step-up, so a thief holding an unlocked phone cannot simply choose a new one.
func (s *Service) SetPin(ctx context.Context, pin string) error {
	p, err := principal(ctx)
	if err != nil {
		return err
	}
	user, err := s.q.GetUser(ctx, p.UserID)
	if err != nil {
		return fmt.Errorf("load user: %w", err)
	}
	if user.PinHash != nil {
		return ErrPinExists
	}
	if IsWeakPin(pin, user.DateOfBirth) {
		return ErrWeakPin
	}
	hash, err := s.hasher.Hash(ctx, pin)
	if err != nil {
		return err
	}
	return s.inTx(ctx, func(q *identitydb.Queries) error {
		u, err := q.GetUserForUpdate(ctx, p.UserID)
		if err != nil {
			return fmt.Errorf("lock user: %w", err)
		}
		if u.PinHash != nil {
			return ErrPinExists // set by a parallel request
		}
		if err := q.SetPinHash(ctx, identitydb.SetPinHashParams{ID: u.ID, PinHash: &hash}); err != nil {
			return fmt.Errorf("set pin: %w", err)
		}
		return nil
	})
}

// VerifyPin checks the PIN with AUTH-4's lockout. The user row stays locked through the
// argon2id check, so parallel guesses queue and each is counted.
//
// The duress PIN (SEC-5) also verifies as valid, and the response is identical, so whoever
// is watching cannot tell. It switches the account into duress mode and raises a silent
// alert; the real PIN switches it back. When a duress PIN is set both hashes are always
// checked, so timing does not reveal which PIN was typed either.
//
// A locked PIN is a 200 with valid false and locked_until, the shape the app renders.
func (s *Service) VerifyPin(ctx context.Context, pin string) (PinResult, error) {
	p, err := principal(ctx)
	if err != nil {
		return PinResult{}, err
	}
	var out PinResult
	err = s.inTxWith(ctx, func(tx pgx.Tx, q *identitydb.Queries) error {
		u, err := q.GetUserForUpdate(ctx, p.UserID)
		if err != nil {
			return fmt.Errorf("lock user: %w", err)
		}
		if u.PinHash == nil {
			return ErrPinNotSet
		}
		now := s.now()
		if u.PinLockedUntil != nil && now.Before(*u.PinLockedUntil) {
			out = PinResult{LockedUntil: u.PinLockedUntil}
			return nil
		}
		genuine, err := s.hasher.Verify(ctx, pin, *u.PinHash)
		if err != nil {
			return err
		}
		duress := false
		if u.DuressPinHash != nil {
			if duress, err = s.hasher.Verify(ctx, pin, *u.DuressPinHash); err != nil {
				return err
			}
		}

		if genuine || duress {
			var since *time.Time
			if duress {
				since = u.DuressSince
				if since == nil {
					since = &now
					if err := s.raiseDuressAlert(ctx, tx, u.ID, p); err != nil {
						return err
					}
				}
			}
			if err := q.RecordPinSuccess(ctx, identitydb.RecordPinSuccessParams{ID: u.ID, DuressSince: since}); err != nil {
				return fmt.Errorf("record pin success: %w", err)
			}
			out = PinResult{Valid: true, AttemptsLeft: PinMaxAttempts}
			return nil
		}

		failures, lockouts := u.PinFailures+1, u.PinLockouts
		var until *time.Time
		if failures >= PinMaxAttempts {
			lockouts++
			t := now.Add(PinLockout(int(lockouts)))
			until, failures = &t, 0
		}
		if err := q.RecordPinFailure(ctx, identitydb.RecordPinFailureParams{
			ID: u.ID, PinFailures: failures, PinLockouts: lockouts, PinLockedUntil: until,
		}); err != nil {
			return fmt.Errorf("record pin failure: %w", err)
		}
		out = PinResult{AttemptsLeft: PinMaxAttempts - int(failures), LockedUntil: until}
		if until != nil {
			out.AttemptsLeft = 0
		}
		return nil
	})
	return out, err
}

// raiseDuressAlert is the silent alert for staff (SEC-5). It goes through the outbox, so
// it exists exactly when duress mode was recorded; nothing is sent to the customer's
// devices, where the person forcing them would see it.
func (s *Service) raiseDuressAlert(ctx context.Context, tx pgx.Tx, userID uuid.UUID, p Principal) error {
	if _, err := jobs.Write(ctx, tx, jobs.Event{
		Topic: "security.duress_triggered", AggregateType: "user", AggregateID: userID.String(),
		Payload: map[string]any{"session_id": p.SessionID, "device_id": p.DeviceID},
	}); err != nil {
		return err
	}
	// Staff see it in the audit log; the customer's devices never do.
	return s.audit(ctx, tx, audit.System(), "security.duress_triggered", "user", userID.String(),
		map[string]any{"session_id": p.SessionID, "device_id": p.DeviceID})
}

// InDuress reports whether the customer is in duress mode. Transfers block silently and
// balances show the decoy view while it is on.
func (s *Service) InDuress(ctx context.Context, userID uuid.UUID) (bool, error) {
	since, err := s.q.GetDuressSince(ctx, userID)
	if err != nil {
		return false, fmt.Errorf("load duress state: %w", err)
	}
	return since != nil, nil
}

// consumeStepUp spends a step-up token earned for purpose by this user, inside the
// caller's transaction. A token works once, for one purpose, before it expires.
func (s *Service) consumeStepUp(ctx context.Context, q *identitydb.Queries, userID uuid.UUID, purpose, token string) error {
	if token == "" {
		return ErrStepUpRequired
	}
	c, err := q.GetStepUpChallengeByTokenForUpdate(ctx, hashToken(token))
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrStepUpRequired
	}
	if err != nil {
		return fmt.Errorf("load step-up: %w", err)
	}
	if c.SubjectID != userID || c.StepUpPurpose == nil || *c.StepUpPurpose != purpose || c.ConsumedAt != nil ||
		c.TokenExpiresAt == nil || !s.now().Before(*c.TokenExpiresAt) {
		return ErrStepUpRequired
	}
	if err := q.ConsumeChallenge(ctx, c.ID); err != nil {
		return fmt.Errorf("consume step-up: %w", err)
	}
	return nil
}

// pinChange runs a step-up-gated PIN change. The new PIN is hashed before the transaction;
// apply runs with the user row locked and the step-up already spent. In duress mode the
// change is skipped but still reported as done: whoever forces the phone must not be able
// to disarm the duress PIN or take over the real one.
func (s *Service) pinChange(ctx context.Context, action, stepUp, pin string, apply func(q *identitydb.Queries, u identitydb.User, hash *string) error) error {
	p, err := principal(ctx)
	if err != nil {
		return err
	}
	var hash *string
	if pin != "" {
		user, err := s.q.GetUser(ctx, p.UserID)
		if err != nil {
			return fmt.Errorf("load user: %w", err)
		}
		if IsWeakPin(pin, user.DateOfBirth) {
			return ErrWeakPin
		}
		h, err := s.hasher.Hash(ctx, pin)
		if err != nil {
			return err
		}
		hash = &h
	}
	return s.inTxWith(ctx, func(tx pgx.Tx, q *identitydb.Queries) error {
		u, err := q.GetUserForUpdate(ctx, p.UserID)
		if err != nil {
			return fmt.Errorf("lock user: %w", err)
		}
		if err := s.consumeStepUp(ctx, q, u.ID, "pin_reset", stepUp); err != nil {
			return err
		}
		if u.DuressSince != nil {
			return nil
		}
		if err := apply(q, u, hash); err != nil {
			return err
		}
		return s.audit(ctx, tx, audit.Customer(u.ID), action, "user", u.ID.String(),
			map[string]any{"device_id": p.DeviceID})
	})
}

// samePin reports whether pin matches an existing hash (nil means no such PIN).
func (s *Service) samePin(ctx context.Context, pin string, hash *string) (bool, error) {
	if hash == nil {
		return false, nil
	}
	return s.hasher.Verify(ctx, pin, *hash)
}

// ResetPin replaces the PIN after step-up (AUTH-9) and clears any lockout.
func (s *Service) ResetPin(ctx context.Context, stepUp, pin string) error {
	return s.pinChange(ctx, "pin.reset", stepUp, pin, func(q *identitydb.Queries, u identitydb.User, hash *string) error {
		if same, err := s.samePin(ctx, pin, u.DuressPinHash); err != nil {
			return err
		} else if same {
			return ErrPinSameAsDuress
		}
		if err := q.SetPinHash(ctx, identitydb.SetPinHashParams{ID: u.ID, PinHash: hash}); err != nil {
			return fmt.Errorf("reset pin: %w", err)
		}
		return nil
	})
}

// SetDuressPin sets or replaces the duress PIN (SEC-5), which must differ from the PIN.
func (s *Service) SetDuressPin(ctx context.Context, stepUp, pin string) error {
	return s.pinChange(ctx, "duress_pin.set", stepUp, pin, func(q *identitydb.Queries, u identitydb.User, hash *string) error {
		if u.PinHash == nil {
			return ErrPinNotSet
		}
		if same, err := s.samePin(ctx, pin, u.PinHash); err != nil {
			return err
		} else if same {
			return ErrDuressSameAsPin
		}
		if err := q.SetDuressPinHash(ctx, identitydb.SetDuressPinHashParams{ID: u.ID, DuressPinHash: hash}); err != nil {
			return fmt.Errorf("set duress pin: %w", err)
		}
		return nil
	})
}

// RemoveDuressPin removes the duress PIN.
func (s *Service) RemoveDuressPin(ctx context.Context, stepUp string) error {
	return s.pinChange(ctx, "duress_pin.remove", stepUp, "", func(q *identitydb.Queries, u identitydb.User, _ *string) error {
		if err := q.SetDuressPinHash(ctx, identitydb.SetDuressPinHashParams{ID: u.ID}); err != nil {
			return fmt.Errorf("remove duress pin: %w", err)
		}
		return nil
	})
}

// CustomerProfile is what other domains need to know about a customer to show their
// money: the name on the account, the KYC tier and whether the decoy view is on.
type CustomerProfile struct {
	Name     string
	KycTier  int
	InDuress bool
}

// CustomerProfile loads the customer's profile.
func (s *Service) CustomerProfile(ctx context.Context, userID uuid.UUID) (CustomerProfile, error) {
	u, err := s.q.GetUser(ctx, userID)
	if err != nil {
		return CustomerProfile{}, fmt.Errorf("load user: %w", err)
	}
	return CustomerProfile{
		Name: u.FirstName + " " + u.LastName, KycTier: int(u.KycTier), InDuress: u.DuressSince != nil,
	}, nil
}
