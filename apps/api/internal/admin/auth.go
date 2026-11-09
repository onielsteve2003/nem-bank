package admin

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/admin/admindb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/audit"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

const (
	challengeTTL     = 5 * time.Minute
	maxTOTPAttempts  = 5
	staffPasswordMin = 12
)

// StaffInput is a new staff account.
type StaffInput struct {
	Name, Email, Password string
	Roles                 []Role
}

// totpAAD binds a TOTP secret's ciphertext to its staff row, so it cannot be copied onto
// another account.
func totpAAD(id uuid.UUID) []byte { return []byte("staff.totp_secret:" + id.String()) }

func normalizeEmail(e string) string { return strings.ToLower(strings.TrimSpace(e)) }

// CreateStaff adds a staff account. It is run by an operator (`api create-staff`), never
// through the public API: no endpoint can create staff, so a compromised console session
// cannot mint new insiders. The account must enrol TOTP on its first login.
func (s *Service) CreateStaff(ctx context.Context, in StaffInput) (admindb.Staff, error) {
	in.Name = strings.TrimSpace(in.Name)
	in.Email = normalizeEmail(in.Email)
	if in.Name == "" || !strings.Contains(in.Email, "@") || len(in.Roles) == 0 {
		return admindb.Staff{}, errors.New("create staff: name, email and at least one role are required")
	}
	roles := make([]string, len(in.Roles))
	for i, r := range in.Roles {
		if !validRole(r) {
			return admindb.Staff{}, fmt.Errorf("create staff: unknown role %q", r)
		}
		roles[i] = string(r)
	}
	if len(in.Password) < staffPasswordMin {
		return admindb.Staff{}, fmt.Errorf("create staff: staff passwords need at least %d characters", staffPasswordMin)
	}
	if msg := identity.CheckPassword(in.Password, identity.PasswordContext{FirstName: in.Name, Email: in.Email}); msg != "" {
		return admindb.Staff{}, fmt.Errorf("create staff: %s", msg)
	}
	hash, err := s.hasher.Hash(ctx, in.Password)
	if err != nil {
		return admindb.Staff{}, fmt.Errorf("create staff: %w", err)
	}
	id, err := newID()
	if err != nil {
		return admindb.Staff{}, err
	}
	secret := make([]byte, totpKeySize)
	if _, err := rand.Read(secret); err != nil {
		return admindb.Staff{}, fmt.Errorf("create staff: totp secret: %w", err)
	}
	sealed, err := s.keyring.Encrypt(secret, totpAAD(id))
	if err != nil {
		return admindb.Staff{}, fmt.Errorf("create staff: %w", err)
	}
	var st admindb.Staff
	err = s.inTx(ctx, func(tx pgx.Tx, q *admindb.Queries) error {
		st, err = q.InsertStaff(ctx, admindb.InsertStaffParams{
			ID: id, Name: in.Name, Email: in.Email, PasswordHash: hash, Roles: roles, TotpSecret: sealed,
		})
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				return errors.New("a staff account already uses this email")
			}
			return fmt.Errorf("insert staff: %w", err)
		}
		return s.audit(ctx, tx, audit.System(), "staff.create", "staff", id.String(), map[string]any{"roles": strings.Join(roles, ",")})
	})
	return st, err
}

// LoginChallenge is step 1's answer: send a TOTP code for it next.
type LoginChallenge struct {
	ID        uuid.UUID
	ExpiresAt time.Time
	// EnrolmentURI is set until the first code is accepted: the QR to scan.
	EnrolmentURI *string
}

// Login checks the password and opens a TOTP challenge. A password alone never yields a
// session (ADM-1).
func (s *Service) Login(ctx context.Context, email, password string) (LoginChallenge, error) {
	st, err := s.q.GetStaffByEmail(ctx, normalizeEmail(email))
	if errors.Is(err, pgx.ErrNoRows) {
		// Same argon2id cost as a real check, so timing does not reveal who is staff.
		if dummy, derr := s.dummyHash(); derr == nil {
			_, _ = s.hasher.Verify(ctx, password, dummy)
		}
		return LoginChallenge{}, ErrInvalidCredentials
	}
	if err != nil {
		return LoginChallenge{}, fmt.Errorf("load staff: %w", err)
	}
	ok, err := s.hasher.Verify(ctx, password, st.PasswordHash)
	if err != nil {
		return LoginChallenge{}, fmt.Errorf("verify staff password: %w", err)
	}
	if !ok || st.DisabledAt != nil {
		// A failed login for a real account is evidence an insider-abuse review wants.
		if aerr := s.inTx(ctx, func(tx pgx.Tx, _ *admindb.Queries) error {
			return s.audit(ctx, tx, staffActor(st.ID, st.Name), "staff.login_failed", "staff", st.ID.String(), map[string]any{"step": "password"})
		}); aerr != nil {
			return LoginChallenge{}, aerr
		}
		return LoginChallenge{}, ErrInvalidCredentials
	}

	now := s.now()
	id, err := newID()
	if err != nil {
		return LoginChallenge{}, err
	}
	var ch admindb.StaffLoginChallenge
	err = s.inTx(ctx, func(_ pgx.Tx, q *admindb.Queries) error {
		if err := q.PruneLoginChallenges(ctx, admindb.PruneLoginChallengesParams{StaffID: st.ID, Before: now}); err != nil {
			return fmt.Errorf("prune challenges: %w", err)
		}
		ch, err = q.InsertLoginChallenge(ctx, admindb.InsertLoginChallengeParams{ID: id, StaffID: st.ID, ExpiresAt: now.Add(challengeTTL)})
		if err != nil {
			return fmt.Errorf("insert challenge: %w", err)
		}
		return nil
	})
	if err != nil {
		return LoginChallenge{}, err
	}
	out := LoginChallenge{ID: ch.ID, ExpiresAt: ch.ExpiresAt}
	if st.TotpEnrolledAt == nil {
		secret, err := s.keyring.Decrypt(st.TotpSecret, totpAAD(st.ID))
		if err != nil {
			return LoginChallenge{}, fmt.Errorf("open totp secret: %w", err)
		}
		uri := otpauthURI(secret, st.Email)
		out.EnrolmentURI = &uri
	}
	return out, nil
}

// Session is a signed-in console session.
type Session struct {
	AccessToken string
	ExpiresAt   time.Time
	Staff       admindb.Staff
}

// VerifyTOTP is login step 2: a valid, unused code for the challenge opens a session.
// Five wrong codes end the challenge; the next try must start again with the password.
func (s *Service) VerifyTOTP(ctx context.Context, challengeID uuid.UUID, code string) (Session, error) {
	now := s.now()
	var out Session
	// A wrong code must still count, so failures commit the attempt and return afterwards.
	var fail error
	err := s.inTx(ctx, func(tx pgx.Tx, q *admindb.Queries) error {
		ch, err := q.GetLoginChallengeForUpdate(ctx, challengeID)
		if errors.Is(err, pgx.ErrNoRows) {
			fail = ErrChallengeExpired
			return nil
		}
		if err != nil {
			return fmt.Errorf("load challenge: %w", err)
		}
		if ch.UsedAt != nil || !now.Before(ch.ExpiresAt) {
			fail = ErrChallengeExpired
			return nil
		}
		if ch.Attempts >= maxTOTPAttempts {
			fail = ErrTOTPExhausted
			return q.UseLoginChallenge(ctx, admindb.UseLoginChallengeParams{ID: ch.ID, At: &now})
		}
		st, err := q.GetStaff(ctx, ch.StaffID)
		if err != nil {
			return fmt.Errorf("load staff: %w", err)
		}
		if st.DisabledAt != nil {
			fail = ErrInvalidCredentials
			return q.UseLoginChallenge(ctx, admindb.UseLoginChallengeParams{ID: ch.ID, At: &now})
		}
		secret, err := s.keyring.Decrypt(st.TotpSecret, totpAAD(st.ID))
		if err != nil {
			return fmt.Errorf("open totp secret: %w", err)
		}
		wasEnrolled := st.TotpEnrolledAt != nil
		counter, ok := verifyTOTP(secret, code, now)
		if ok {
			// Only a step later than the last one used: a replayed code fails here.
			accepted, err := q.AcceptTotpStep(ctx, admindb.AcceptTotpStepParams{ID: st.ID, Counter: int64(counter), At: &now}) //nolint:gosec // a 30 s step count fits int64 for billions of years
			switch {
			case errors.Is(err, pgx.ErrNoRows):
				ok = false
			case err != nil:
				return fmt.Errorf("accept totp step: %w", err)
			default:
				st = accepted
			}
		}
		if !ok {
			fail = ErrInvalidTOTP
			if err := q.CountLoginChallengeAttempt(ctx, ch.ID); err != nil {
				return fmt.Errorf("count attempt: %w", err)
			}
			return s.audit(ctx, tx, staffActor(st.ID, st.Name), "staff.login_failed", "staff", st.ID.String(), map[string]any{"step": "totp"})
		}
		firstEnrol := !wasEnrolled
		if err := q.UseLoginChallenge(ctx, admindb.UseLoginChallengeParams{ID: ch.ID, At: &now}); err != nil {
			return fmt.Errorf("use challenge: %w", err)
		}
		sessID, err := newID()
		if err != nil {
			return err
		}
		sess, err := q.InsertStaffSession(ctx, admindb.InsertStaffSessionParams{ID: sessID, StaffID: st.ID, CreatedAt: now, ExpiresAt: now.Add(sessionTTL)})
		if err != nil {
			return fmt.Errorf("insert staff session: %w", err)
		}
		tok, err := s.tokens.sign(st.ID, sess.ID, now, sess.ExpiresAt)
		if err != nil {
			return err
		}
		actor := staffActor(st.ID, st.Name)
		if firstEnrol {
			if err := s.audit(ctx, tx, actor, "staff.totp_enrol", "staff", st.ID.String(), nil); err != nil {
				return err
			}
		}
		if err := s.audit(ctx, tx, actor, "staff.login", "staff_session", sess.ID.String(), nil); err != nil {
			return err
		}
		out = Session{AccessToken: tok, ExpiresAt: sess.ExpiresAt, Staff: st}
		return nil
	})
	if err != nil {
		return Session{}, err
	}
	if fail != nil {
		return Session{}, fail
	}
	return out, nil
}

// Authenticate verifies a console token and returns ctx carrying the staff member. The
// session and account are checked on every request, so logout, expiry and disabling an
// account end access at once.
func (s *Service) Authenticate(ctx context.Context, bearer string) (context.Context, error) {
	now := s.now()
	staffID, sessionID, err := s.tokens.verify(bearer, now)
	if err != nil {
		return nil, problem.Unauthorized().WithCause(err)
	}
	row, err := s.q.GetStaffSession(ctx, sessionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrSessionEnded
	}
	if err != nil {
		return nil, fmt.Errorf("load staff session: %w", err)
	}
	sess, st := row.StaffSession, row.Staff
	if st.ID != staffID || sess.RevokedAt != nil || !now.Before(sess.ExpiresAt) || st.DisabledAt != nil {
		return nil, ErrSessionEnded
	}
	roles := make([]Role, len(st.Roles))
	for i, r := range st.Roles {
		roles[i] = Role(r)
	}
	return WithPrincipal(ctx, Principal{StaffID: st.ID, SessionID: sess.ID, Name: st.Name, Roles: roles}), nil
}

func principal(ctx context.Context) (Principal, error) {
	p, ok := PrincipalFrom(ctx)
	if !ok {
		return Principal{}, problem.Unauthorized()
	}
	return p, nil
}

// Logout ends the current console session.
func (s *Service) Logout(ctx context.Context) error {
	p, err := principal(ctx)
	if err != nil {
		return err
	}
	now := s.now()
	return s.inTx(ctx, func(tx pgx.Tx, q *admindb.Queries) error {
		if err := q.RevokeStaffSession(ctx, admindb.RevokeStaffSessionParams{ID: p.SessionID, At: &now}); err != nil {
			return fmt.Errorf("revoke staff session: %w", err)
		}
		return s.audit(ctx, tx, staffActor(p.StaffID, p.Name), "staff.logout", "staff_session", p.SessionID.String(), nil)
	})
}

// Me returns the signed-in staff member.
func (s *Service) Me(ctx context.Context) (admindb.Staff, error) {
	p, err := principal(ctx)
	if err != nil {
		return admindb.Staff{}, err
	}
	st, err := s.q.GetStaff(ctx, p.StaffID)
	if err != nil {
		return admindb.Staff{}, fmt.Errorf("load staff: %w", err)
	}
	return st, nil
}
