package identity

import (
	"context"
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
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// newDeviceCoolOff is AUTH-8: reduced outgoing limits for a day after a login binds a
// new device. The first device, bound at sign-up, has nobody to protect from it.
const newDeviceCoolOff = 24 * time.Hour

// Session problems. Codes match the app's mock bank.
var (
	ErrInvalidCredentials = problem.New(http.StatusUnauthorized, "invalid_credentials", "Email or password is not right")
	ErrInvalidToken       = problem.New(http.StatusUnauthorized, "invalid_token", "Your session has ended. Sign in again.")
	ErrSessionRevoked     = problem.New(http.StatusUnauthorized, "session_revoked", "Your session has ended. Sign in again.")
	ErrDeviceNotBound     = problem.New(http.StatusUnauthorized, "device_not_bound", "This device is not linked to your account. Sign in with your password.")
	ErrDeviceRequired     = problem.Validation(problem.Field("/device", "required", "Send device_id from a trusted device or device to link this one."))
	ErrDeviceKeyInUse     = problem.New(http.StatusConflict, "device_key_in_use", "This device key is linked to another account.")
	ErrDeviceNotFound     = problem.NotFound("Device")
	ErrRevokeCurrent      = problem.New(http.StatusConflict, "invalid_state", "You cannot remove the device you are using").
				WithDetail("Log out instead, or remove it from another device.")
	ErrSessionNotFound = problem.NotFound("Session")
)

// DeviceRegistration is a device asking to be bound (contract DeviceRegistration).
type DeviceRegistration struct {
	Name, Platform string
	// PublicKey is the raw 32-byte Ed25519 key, base64url without padding.
	PublicKey      string
	AppVersion     *string
	HardwareBacked bool
}

// AuthResult is a signed-in session: who, on which device, and the tokens.
type AuthResult struct {
	User                  identitydb.User
	Device                identitydb.Device
	AccessToken           string
	AccessTokenExpiresAt  time.Time
	RefreshToken          string
	RefreshTokenExpiresAt time.Time
}

// KeyFingerprint is the first 16 hex characters of SHA-256 of the public key, which the
// app shows so a customer can match a device to its key.
func KeyFingerprint(pub []byte) string {
	sum := sha256.Sum256(pub)
	return hex.EncodeToString(sum[:8])
}

// bindDevice registers a device key for the user inside the caller's transaction. A key
// already live on this user's account is the same phone coming back (a reinstall that
// kept its keychain), so that device is reused; a key live on another account is refused.
func (s *Service) bindDevice(ctx context.Context, tx pgx.Tx, q *identitydb.Queries, userID uuid.UUID, reg DeviceRegistration, coolOff bool) (identitydb.Device, error) {
	pub, err := base64.RawURLEncoding.DecodeString(reg.PublicKey)
	if err != nil || len(pub) != 32 {
		return identitydb.Device{}, problem.Validation(problem.Field("/device/public_key", "bad_format", "Must be a base64url Ed25519 public key."))
	}
	existing, err := q.GetLiveDeviceByKey(ctx, pub)
	switch {
	case err == nil && existing.UserID == userID:
		d, err := q.TouchDevice(ctx, existing.ID)
		if err != nil {
			return identitydb.Device{}, fmt.Errorf("touch device: %w", err)
		}
		return d, nil
	case err == nil:
		return identitydb.Device{}, ErrDeviceKeyInUse
	case !errors.Is(err, pgx.ErrNoRows):
		return identitydb.Device{}, fmt.Errorf("look up device key: %w", err)
	}

	id, err := newID()
	if err != nil {
		return identitydb.Device{}, err
	}
	var until *time.Time
	if coolOff {
		t := s.now().Add(newDeviceCoolOff)
		until = &t
	}
	d, err := q.InsertDevice(ctx, identitydb.InsertDeviceParams{
		ID: id, UserID: userID, Name: strings.TrimSpace(reg.Name), Platform: reg.Platform, PublicKey: pub,
		HardwareBacked: reg.HardwareBacked, AppVersion: reg.AppVersion, CoolOffUntil: until,
	})
	if uniqueViolation(err) == "devices_public_key_live" {
		return identitydb.Device{}, ErrDeviceKeyInUse
	}
	if err != nil {
		return identitydb.Device{}, fmt.Errorf("insert device: %w", err)
	}
	if coolOff {
		// The notifications domain alerts the customer's other devices (AUTH-8).
		if _, err := jobs.Write(ctx, tx, jobs.Event{
			Topic: "identity.device_bound", AggregateType: "user", AggregateID: userID.String(),
			Payload: map[string]any{"device_id": d.ID, "platform": d.Platform, "cool_off_until": until},
		}); err != nil {
			return identitydb.Device{}, err
		}
	}
	return d, nil
}

// openSession starts a session on the device, replacing any session it already had (one
// login per device), and issues the first refresh token of its family.
func (s *Service) openSession(ctx context.Context, q *identitydb.Queries, user identitydb.User, device identitydb.Device) (AuthResult, error) {
	if err := q.RevokeDeviceSessions(ctx, identitydb.RevokeDeviceSessionsParams{Reason: ptr("replaced"), DeviceID: device.ID}); err != nil {
		return AuthResult{}, fmt.Errorf("replace device sessions: %w", err)
	}
	id, err := newID()
	if err != nil {
		return AuthResult{}, err
	}
	now := s.now()
	sess, err := q.InsertSession(ctx, identitydb.InsertSessionParams{
		ID: id, UserID: user.ID, DeviceID: device.ID, ExpiresAt: now.Add(sessionMaxAge),
	})
	if err != nil {
		return AuthResult{}, fmt.Errorf("insert session: %w", err)
	}
	return s.issueTokens(ctx, q, user, device, sess)
}

// issueTokens adds a refresh token to the session's family and signs an access token.
func (s *Service) issueTokens(ctx context.Context, q *identitydb.Queries, user identitydb.User, device identitydb.Device, sess identitydb.Session) (AuthResult, error) {
	now := s.now()
	refresh, err := newToken()
	if err != nil {
		return AuthResult{}, err
	}
	refresh = "nrt_" + refresh
	refreshExp := now.Add(refreshTTL)
	if sess.ExpiresAt.Before(refreshExp) {
		refreshExp = sess.ExpiresAt
	}
	id, err := newID()
	if err != nil {
		return AuthResult{}, err
	}
	if err := q.InsertRefreshToken(ctx, identitydb.InsertRefreshTokenParams{
		ID: id, SessionID: sess.ID, TokenHash: hashToken(refresh), ExpiresAt: refreshExp,
	}); err != nil {
		return AuthResult{}, fmt.Errorf("insert refresh token: %w", err)
	}
	access, accessExp, err := s.tokens.sign(Principal{UserID: user.ID, SessionID: sess.ID, DeviceID: device.ID}, now)
	if err != nil {
		return AuthResult{}, err
	}
	return AuthResult{
		User: user, Device: device,
		AccessToken: access, AccessTokenExpiresAt: accessExp,
		RefreshToken: refresh, RefreshTokenExpiresAt: refreshExp,
	}, nil
}

// LoginInput is a password login (AUTH-7). Exactly one of DeviceID (a trusted device) or
// Device (bind this one) is expected.
type LoginInput struct {
	Identifier, Password string
	DeviceID             *uuid.UUID
	Device               *DeviceRegistration
}

// normalizeIdentifier turns an email or Nigerian phone into its stored form. Local
// "0803..." numbers are accepted as well as +234.
func normalizeIdentifier(id string) (value string, isPhone bool) {
	id = strings.TrimSpace(id)
	if strings.Contains(id, "@") {
		return NormalizeEmail(id), false
	}
	digits := strings.NewReplacer(" ", "", "-", "").Replace(id)
	if len(digits) == 11 && strings.HasPrefix(digits, "0") {
		digits = "+234" + digits[1:]
	}
	return digits, true
}

// Login checks the password and opens a session. A login from an unknown device binds it
// and starts the cool-off. Every failure before the password check looks the same as a
// wrong password, and costs the same time.
func (s *Service) Login(ctx context.Context, in LoginInput) (AuthResult, error) {
	if in.DeviceID == nil && in.Device == nil {
		return AuthResult{}, ErrDeviceRequired
	}
	value, isPhone := normalizeIdentifier(in.Identifier)
	var user identitydb.User
	var err error
	if isPhone {
		user, err = s.q.GetUserByPhone(ctx, value)
	} else {
		user, err = s.q.GetUserByEmail(ctx, value)
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return AuthResult{}, fmt.Errorf("look up user: %w", err)
	}
	hash := user.PasswordHash
	if errors.Is(err, pgx.ErrNoRows) {
		if hash, err = s.dummyHash(); err != nil {
			return AuthResult{}, err
		}
	}
	ok, err := s.hasher.Verify(ctx, in.Password, hash)
	if err != nil {
		return AuthResult{}, err
	}
	if !ok || user.ID == uuid.Nil {
		return AuthResult{}, ErrInvalidCredentials
	}

	var out AuthResult
	err = s.inTxWith(ctx, func(tx pgx.Tx, q *identitydb.Queries) error {
		var device identitydb.Device
		var err error
		if in.DeviceID != nil {
			device, err = q.GetLiveDevice(ctx, identitydb.GetLiveDeviceParams{ID: *in.DeviceID, UserID: user.ID})
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrDeviceNotBound
			}
			if err != nil {
				return fmt.Errorf("load device: %w", err)
			}
			if device, err = q.TouchDevice(ctx, device.ID); err != nil {
				return fmt.Errorf("touch device: %w", err)
			}
		} else if device, err = s.bindDevice(ctx, tx, q, user.ID, *in.Device, true); err != nil {
			return err
		}
		out, err = s.openSession(ctx, q, user, device)
		return err
	})
	return out, err
}

// Refresh rotates a refresh token: the presented one is spent and a new one issued in the
// same family. A spent token presented again was copied (the app always replaces its
// token), so the whole session is revoked and both holders must sign in again. Two
// refreshes racing with one token are serialised by the row lock, so exactly one wins.
func (s *Service) Refresh(ctx context.Context, token string) (AuthResult, error) {
	var out AuthResult
	var reused bool
	err := s.inTxWith(ctx, func(tx pgx.Tx, q *identitydb.Queries) error {
		rt, err := q.GetRefreshTokenForUpdate(ctx, hashToken(token))
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrInvalidToken
		}
		if err != nil {
			return fmt.Errorf("load refresh token: %w", err)
		}
		sess, err := q.GetSession(ctx, rt.SessionID)
		if err != nil {
			return fmt.Errorf("load session: %w", err)
		}
		now := s.now()
		if rt.UsedAt != nil {
			reused = true
			if sess.RevokedAt != nil {
				return nil // already dealt with
			}
			if _, err := q.RevokeSession(ctx, identitydb.RevokeSessionParams{
				Reason: ptr("token_reuse"), ID: sess.ID, UserID: sess.UserID,
			}); err != nil {
				return fmt.Errorf("revoke reused session: %w", err)
			}
			_, err := jobs.Write(ctx, tx, jobs.Event{
				Topic: "identity.refresh_token_reused", AggregateType: "user", AggregateID: sess.UserID.String(),
				Payload: map[string]any{"session_id": sess.ID, "device_id": sess.DeviceID},
			})
			return err
		}
		if sess.RevokedAt != nil || !now.Before(sess.ExpiresAt) || !now.Before(rt.ExpiresAt) {
			return ErrInvalidToken
		}
		if err := q.MarkRefreshTokenUsed(ctx, rt.ID); err != nil {
			return fmt.Errorf("spend refresh token: %w", err)
		}
		if err := q.TouchSession(ctx, sess.ID); err != nil {
			return fmt.Errorf("touch session: %w", err)
		}
		user, err := q.GetUser(ctx, sess.UserID)
		if err != nil {
			return fmt.Errorf("load user: %w", err)
		}
		device, err := q.TouchDevice(ctx, sess.DeviceID)
		if err != nil {
			return fmt.Errorf("touch device: %w", err)
		}
		out, err = s.issueTokens(ctx, q, user, device, sess)
		return err
	})
	if err != nil {
		return AuthResult{}, err
	}
	if reused {
		// Committed above: the revocation must stick even though this call fails.
		s.log.WarnContext(ctx, "refresh token reused; session revoked")
		return AuthResult{}, ErrInvalidToken
	}
	return out, nil
}

// Authenticate verifies a bearer access token and returns ctx carrying the caller. The
// session is checked too (one primary-key read), so logout and device revocation take
// effect at once instead of when the 10-minute token expires.
func (s *Service) Authenticate(ctx context.Context, bearer string) (context.Context, error) {
	p, err := s.tokens.verify(bearer, s.now())
	if err != nil {
		return nil, problem.Unauthorized().WithCause(err)
	}
	sess, err := s.q.GetSession(ctx, p.SessionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrSessionRevoked
	}
	if err != nil {
		return nil, fmt.Errorf("load session: %w", err)
	}
	if sess.UserID != p.UserID || sess.DeviceID != p.DeviceID || sess.RevokedAt != nil || !s.now().Before(sess.ExpiresAt) {
		return nil, ErrSessionRevoked
	}
	return WithPrincipal(ctx, p), nil
}

func principal(ctx context.Context) (Principal, error) {
	p, ok := PrincipalFrom(ctx)
	if !ok {
		return Principal{}, problem.Unauthorized()
	}
	return p, nil
}

// Logout ends the current session, or every session when all is set.
func (s *Service) Logout(ctx context.Context, all bool) error {
	p, err := principal(ctx)
	if err != nil {
		return err
	}
	if all {
		if err := s.q.RevokeUserSessions(ctx, identitydb.RevokeUserSessionsParams{Reason: ptr("logout_all"), UserID: p.UserID}); err != nil {
			return fmt.Errorf("revoke sessions: %w", err)
		}
		return nil
	}
	if _, err := s.q.RevokeSession(ctx, identitydb.RevokeSessionParams{Reason: ptr("logout"), ID: p.SessionID, UserID: p.UserID}); err != nil {
		return fmt.Errorf("revoke session: %w", err)
	}
	return nil
}

// Me returns the signed-in customer.
func (s *Service) Me(ctx context.Context) (identitydb.User, error) {
	p, err := principal(ctx)
	if err != nil {
		return identitydb.User{}, err
	}
	u, err := s.q.GetUser(ctx, p.UserID)
	if err != nil {
		return identitydb.User{}, fmt.Errorf("load user: %w", err)
	}
	return u, nil
}

// Devices lists the customer's bound devices.
func (s *Service) Devices(ctx context.Context) ([]identitydb.Device, Principal, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, Principal{}, err
	}
	ds, err := s.q.ListLiveDevices(ctx, p.UserID)
	if err != nil {
		return nil, Principal{}, fmt.Errorf("list devices: %w", err)
	}
	return ds, p, nil
}

// RevokeDevice unbinds another device and ends its sessions (SEC-2). The current device
// is refused, as in the app: removing it would also strand its key with no way back in.
func (s *Service) RevokeDevice(ctx context.Context, deviceID uuid.UUID) error {
	p, err := principal(ctx)
	if err != nil {
		return err
	}
	if deviceID == p.DeviceID {
		return ErrRevokeCurrent
	}
	return s.inTx(ctx, func(q *identitydb.Queries) error {
		n, err := q.RevokeDevice(ctx, identitydb.RevokeDeviceParams{ID: deviceID, UserID: p.UserID})
		if err != nil {
			return fmt.Errorf("revoke device: %w", err)
		}
		if n == 0 {
			return ErrDeviceNotFound
		}
		if err := q.RevokeDeviceSessions(ctx, identitydb.RevokeDeviceSessionsParams{Reason: ptr("device_revoked"), DeviceID: deviceID}); err != nil {
			return fmt.Errorf("revoke device sessions: %w", err)
		}
		return nil
	})
}

// Sessions lists the customer's live sessions across devices.
func (s *Service) Sessions(ctx context.Context) ([]identitydb.ListLiveSessionsRow, Principal, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, Principal{}, err
	}
	rows, err := s.q.ListLiveSessions(ctx, p.UserID)
	if err != nil {
		return nil, Principal{}, fmt.Errorf("list sessions: %w", err)
	}
	return rows, p, nil
}

// RevokeSession ends one of the customer's sessions.
func (s *Service) RevokeSession(ctx context.Context, sessionID uuid.UUID) error {
	p, err := principal(ctx)
	if err != nil {
		return err
	}
	n, err := s.q.RevokeSession(ctx, identitydb.RevokeSessionParams{Reason: ptr("session_revoked"), ID: sessionID, UserID: p.UserID})
	if err != nil {
		return fmt.Errorf("revoke session: %w", err)
	}
	if n == 0 {
		return ErrSessionNotFound
	}
	return nil
}

func ptr[T any](v T) *T { return &v }
