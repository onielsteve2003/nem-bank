package identity

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/audit"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity/identitydb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// maxAvatarLength is 1 MB of image as a base64 data URI.
const maxAvatarLength = 1_400_000

var avatarPattern = regexp.MustCompile(`^data:image/(jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$`)

// Profile is the customer and the profile fields kept outside the generated user row.
type Profile struct {
	User   identitydb.User
	Avatar *string
}

// ProfileMe loads the caller with their photo.
func (s *Service) ProfileMe(ctx context.Context) (Profile, error) {
	u, err := s.Me(ctx)
	if err != nil {
		return Profile{}, err
	}
	var avatar *string
	if err := s.pool.QueryRow(ctx, `SELECT avatar_url FROM users WHERE id = $1`, u.ID).Scan(&avatar); err != nil {
		return Profile{}, fmt.Errorf("load avatar: %w", err)
	}
	return Profile{User: u, Avatar: avatar}, nil
}

// UpdateMe is PATCH /v1/users/me. A nil field is left alone; an empty string clears it (the
// contract's null cannot be told apart from an absent field once decoded).
func (s *Service) UpdateMe(ctx context.Context, preferredName, avatar *string) (Profile, error) {
	p, err := principal(ctx)
	if err != nil {
		return Profile{}, err
	}
	if preferredName != nil {
		name := strings.TrimSpace(*preferredName)
		if len([]rune(name)) > 50 {
			return Profile{}, problem.Validation(problem.Field("/preferred_name", "too_long", "Use 50 characters or fewer"))
		}
		var v *string
		if name != "" {
			v = &name
		}
		if _, err := s.pool.Exec(ctx, `UPDATE users SET preferred_name = $2, updated_at = $3 WHERE id = $1`, p.UserID, v, s.now()); err != nil {
			return Profile{}, fmt.Errorf("update preferred name: %w", err)
		}
	}
	if avatar != nil {
		var v *string
		if *avatar != "" {
			if len(*avatar) > maxAvatarLength {
				return Profile{}, problem.Validation(problem.Field("/avatar_url", "too_large", "That photo is too large. Choose a smaller one."))
			}
			if !avatarPattern.MatchString(*avatar) {
				return Profile{}, problem.Validation(problem.Field("/avatar_url", "bad_format", "Use a JPEG or PNG photo"))
			}
			v = avatar
		}
		if _, err := s.pool.Exec(ctx, `UPDATE users SET avatar_url = $2, updated_at = $3 WHERE id = $1`, p.UserID, v, s.now()); err != nil {
			return Profile{}, fmt.Errorf("update avatar: %w", err)
		}
	}
	return s.ProfileMe(ctx)
}

// normalizeAnswer is how a security answer is compared: trimmed and lower-case.
func normalizeAnswer(a string) string { return strings.ToLower(strings.TrimSpace(a)) }

// SetSecurityQuestion is PUT /v1/security/question. The answer is stored only as an Argon2id hash.
func (s *Service) SetSecurityQuestion(ctx context.Context, question, answer string) error {
	p, err := principal(ctx)
	if err != nil {
		return err
	}
	question, answer = strings.TrimSpace(question), normalizeAnswer(answer)
	switch {
	case question == "" || len([]rune(question)) > 120:
		return problem.Validation(problem.Field("/question", "invalid", "Use a question of 1 to 120 characters"))
	case len([]rune(answer)) < 3:
		return problem.Validation(problem.Field("/answer", "too_short", "Use an answer of 3 characters or more"))
	}
	hash, err := s.hasher.Hash(ctx, answer)
	if err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET security_question = $2, security_answer_hash = $3, updated_at = $4 WHERE id = $1`,
		p.UserID, question, hash, s.now()); err != nil {
		return fmt.Errorf("set security question: %w", err)
	}
	return nil
}

// AlertPreferences are the customer's security alert settings (SEC-6).
type AlertPreferences struct {
	LoginAlerts     bool
	NewDeviceAlerts bool
	ThresholdMinor  int64
}

// coolingOff reports whether any of the customer's devices is in its new-device cool-off.
func (s *Service) coolingOff(ctx context.Context, userID uuid.UUID) (bool, error) {
	var on bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM devices WHERE user_id = $1 AND revoked_at IS NULL AND cool_off_until > $2)`,
		userID, s.now()).Scan(&on); err != nil {
		return false, fmt.Errorf("check cool-off: %w", err)
	}
	return on, nil
}

// GetAlertPreferences is GET /v1/security/alerts.
func (s *Service) GetAlertPreferences(ctx context.Context) (AlertPreferences, error) {
	p, err := principal(ctx)
	if err != nil {
		return AlertPreferences{}, err
	}
	var a AlertPreferences
	if err := s.pool.QueryRow(ctx, `SELECT login_alerts, new_device_alerts, alert_threshold_minor FROM users WHERE id = $1`, p.UserID).
		Scan(&a.LoginAlerts, &a.NewDeviceAlerts, &a.ThresholdMinor); err != nil {
		return AlertPreferences{}, fmt.Errorf("load alert preferences: %w", err)
	}
	return a, nil
}

// SetAlertPreferences is PUT /v1/security/alerts. New-device alerts stay on while any device is
// in its cool-off (AUTH-8).
func (s *Service) SetAlertPreferences(ctx context.Context, a AlertPreferences) (AlertPreferences, error) {
	p, err := principal(ctx)
	if err != nil {
		return AlertPreferences{}, err
	}
	if a.ThresholdMinor < 0 {
		return AlertPreferences{}, problem.Validation(problem.Field("/transaction_alert_threshold", "negative", "Use a naira amount of zero or more"))
	}
	cooling, err := s.coolingOff(ctx, p.UserID)
	if err != nil {
		return AlertPreferences{}, err
	}
	a.NewDeviceAlerts = a.NewDeviceAlerts || cooling
	if _, err := s.pool.Exec(ctx, `UPDATE users SET login_alerts = $2, new_device_alerts = $3, alert_threshold_minor = $4, updated_at = $5 WHERE id = $1`,
		p.UserID, a.LoginAlerts, a.NewDeviceAlerts, a.ThresholdMinor, s.now()); err != nil {
		return AlertPreferences{}, fmt.Errorf("save alert preferences: %w", err)
	}
	return a, nil
}

// CheckupItem is one line of the security checkup.
type CheckupItem struct {
	ID, Title, Description string
	Done                   bool
	Points                 int
}

// Checkup is GET /v1/security/checkup. Points add up to 100. Face ID lives on the phone, so the
// server counts a hardware-backed device key (kept in the secure enclave) as biometrics being on.
func (s *Service) Checkup(ctx context.Context) (int, []CheckupItem, error) {
	p, err := principal(ctx)
	if err != nil {
		return 0, nil, err
	}
	var hasPin, hasDuress, hasQuestion, inDuress, alertsOn bool
	var tier int16
	var selfLimit, secureDevice bool
	var devices int
	err = s.pool.QueryRow(ctx, `
SELECT u.pin_hash IS NOT NULL, u.duress_pin_hash IS NOT NULL, u.security_question IS NOT NULL, u.duress_since IS NOT NULL,
       u.login_alerts AND u.new_device_alerts, u.kyc_tier,
       EXISTS (SELECT 1 FROM self_limits l WHERE l.user_id = u.id AND (l.daily_minor IS NOT NULL OR l.single_minor IS NOT NULL)),
       EXISTS (SELECT 1 FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL AND d.hardware_backed),
       (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL)
FROM users u WHERE u.id = $1`, p.UserID).
		Scan(&hasPin, &hasDuress, &hasQuestion, &inDuress, &alertsOn, &tier, &selfLimit, &secureDevice, &devices)
	if err != nil {
		return 0, nil, fmt.Errorf("load checkup: %w", err)
	}
	items := []CheckupItem{
		{"pin_set", "Set a transaction PIN", "Every payment needs it.", hasPin, 20},
		{"kyc_tier_2", "Verify your BVN or NIN", "Protects your account and raises your limits.", tier >= 2, 20},
		{"biometrics_on", "Turn on Face ID", "Faster and safer than typing your PIN.", secureDevice, 10},
		{"security_question_set", "Add a security question", "A backup way to prove it is you.", hasQuestion, 10},
		// In duress the checkup must not give the duress PIN away.
		{"duress_pin_set", "Set a duress PIN", "If someone forces you to open the app, this PIN shows a decoy.", hasDuress && !inDuress, 10},
		{"self_limit_set", "Set your own daily limit", "Caps the damage if someone gets in.", selfLimit, 10},
		{"single_device", "Review your devices", "Remove devices you no longer use.", devices == 1, 10},
		{"alerts_on", "Keep security alerts on", "Hear about new logins and devices straight away.", alertsOn, 10},
	}
	score := 0
	for _, it := range items {
		if it.Done {
			score += it.Points
		}
	}
	return score, items, nil
}

// BindDevice is POST /v1/devices: another device key on the account, behind a device_bind
// step-up, starting the new device's 24-hour cool-off.
func (s *Service) BindDevice(ctx context.Context, stepUp string, reg DeviceRegistration) (identitydb.Device, uuid.UUID, error) {
	p, err := principal(ctx)
	if err != nil {
		return identitydb.Device{}, uuid.Nil, err
	}
	var d identitydb.Device
	err = s.inTxWith(ctx, func(tx pgx.Tx, q *identitydb.Queries) error {
		if err := s.consumeStepUp(ctx, q, p.UserID, "device_bind", stepUp); err != nil {
			return err
		}
		var err error
		d, err = s.bindDevice(ctx, tx, q, p.UserID, reg, true)
		return err
	})
	if err != nil {
		var pe *problem.Error
		if errors.As(err, &pe) {
			return identitydb.Device{}, uuid.Nil, pe
		}
		return identitydb.Device{}, uuid.Nil, err
	}
	return d, p.DeviceID, nil
}

// ForgotPassword is POST /v1/auth/password/forgot. It always answers with a challenge, so the
// answer never shows whether the email has an account; a code is only sent when it does.
func (s *Service) ForgotPassword(ctx context.Context, email string) (Challenge, error) {
	email = NormalizeEmail(email)
	user, err := s.q.GetUserByEmail(ctx, email)
	known := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Challenge{}, fmt.Errorf("look up email: %w", err)
	}
	subject := user.ID
	if !known {
		if subject, err = newID(); err != nil {
			return Challenge{}, err
		}
	}
	var c identitydb.OtpChallenge
	var code string
	if err := s.inTx(ctx, func(q *identitydb.Queries) error {
		var err error
		c, code, err = s.createChallenge(ctx, q, PurposePasswordReset, subject, email, nil)
		return err
	}); err != nil {
		return Challenge{}, err
	}
	if known {
		// A failed send is logged by sendCode and not reported, or the error would tell a
		// stranger the address has an account. The customer can ask for another code.
		_ = s.sendCode(ctx, c, code)
	}
	return challengeOf(c), nil
}

// ResetPassword is POST /v1/auth/password/reset: the emailed code plus a new password. Every
// session ends and every device starts its new-device cool-off, so a stolen session or device
// cannot ride out the reset.
func (s *Service) ResetPassword(ctx context.Context, challengeID uuid.UUID, code, newPassword string) error {
	c, err := s.q.GetChallenge(ctx, challengeID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrChallengeNotFound
	}
	if err != nil {
		return fmt.Errorf("load otp challenge: %w", err)
	}
	if c.Purpose != string(PurposePasswordReset) {
		return ErrOTPInvalid
	}
	user, err := s.q.GetUser(ctx, c.SubjectID)
	known := err == nil && strings.EqualFold(user.Email, c.Destination)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("load user: %w", err)
	}
	var hash string
	if known {
		// Judge the password before the code is spent, so a weak one can be fixed and retried.
		if msg := CheckPassword(newPassword, PasswordContext{
			FirstName: user.FirstName, LastName: user.LastName, Email: user.Email,
			DateOfBirth: user.DateOfBirth.Format(time.DateOnly),
		}); msg != "" {
			return ErrWeakPassword.WithFields(problem.Field("/new_password", "weak", msg))
		}
		if hash, err = s.hasher.Hash(ctx, newPassword); err != nil {
			return err
		}
	}
	if _, err := s.VerifyCode(ctx, challengeID, code); err != nil {
		return err
	}
	if !known {
		return ErrOTPInvalid // a code nobody could have received
	}
	return s.inTxWith(ctx, func(tx pgx.Tx, q *identitydb.Queries) error {
		cur, err := q.GetChallengeForUpdate(ctx, challengeID)
		if err != nil {
			return fmt.Errorf("reload otp challenge: %w", err)
		}
		if cur.ConsumedAt != nil {
			return ErrOTPExpired
		}
		if err := q.ConsumeChallenge(ctx, challengeID); err != nil {
			return fmt.Errorf("consume reset code: %w", err)
		}
		now := s.now()
		if _, err := tx.Exec(ctx, `UPDATE users SET password_hash = $2, updated_at = $3 WHERE id = $1`, user.ID, hash, now); err != nil {
			return fmt.Errorf("set password: %w", err)
		}
		if err := q.RevokeUserSessions(ctx, identitydb.RevokeUserSessionsParams{Reason: ptr("password_reset"), UserID: user.ID}); err != nil {
			return fmt.Errorf("end sessions: %w", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE devices SET cool_off_until = $2 WHERE user_id = $1 AND revoked_at IS NULL`, user.ID, now.Add(newDeviceCoolOff)); err != nil {
			return fmt.Errorf("start cool-off: %w", err)
		}
		if err := s.audit(ctx, tx, audit.Customer(user.ID), "password.reset", "user", user.ID.String(), nil); err != nil {
			return err
		}
		_, err = jobs.Write(ctx, tx, jobs.Event{
			Topic: "identity.password_reset", AggregateType: "user", AggregateID: user.ID.String(),
			Payload: map[string]any{"user_id": user.ID},
		})
		return err
	})
}
