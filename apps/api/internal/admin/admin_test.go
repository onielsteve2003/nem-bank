package admin

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/admin/admindb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/fieldcrypt"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

type harness struct {
	svc   *Service
	clock *clock
}

const staffPassword = "Lagoon-Harmattan-Kettle-42"

func newHarness(t *testing.T) *harness {
	t.Helper()
	keyring, err := fieldcrypt.New(map[uint16][]byte{1: []byte("0123456789abcdef0123456789abcdef")}, []byte("fedcba9876543210fedcba9876543210"))
	if err != nil {
		t.Fatal(err)
	}
	// Postgres keeps microseconds; whole seconds also keep TOTP steps predictable.
	h := &harness{clock: &clock{t: time.Now().Truncate(30 * time.Second).Add(5 * time.Second)}}
	h.svc, err = NewService(Config{
		Pool: testdb.New(t), Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		SigningKey: []byte("staff-signing-seed-0123456789abc"), Keyring: keyring,
		Hasher: identity.NewHasher(identity.Argon2Params{MemoryKiB: 64, Time: 1, Threads: 1}, 2),
		Now:    h.clock.Now,
	})
	if err != nil {
		t.Fatal(err)
	}
	return h
}

// member creates a staff account and returns it with its TOTP secret.
func (h *harness) member(t *testing.T, name, email string, roles ...Role) (admindb.Staff, []byte) {
	t.Helper()
	st, err := h.svc.CreateStaff(t.Context(), StaffInput{Name: name, Email: email, Password: staffPassword, Roles: roles})
	if err != nil {
		t.Fatalf("create staff: %v", err)
	}
	secret, err := h.svc.keyring.Decrypt(st.TotpSecret, totpAAD(st.ID))
	if err != nil {
		t.Fatal(err)
	}
	return st, secret
}

func (h *harness) code(secret []byte) string { return hotp(secret, totpCounter(h.clock.Now())) }

// signIn logs in with password and TOTP and returns a context carrying the staff member.
func (h *harness) signIn(t *testing.T, email string, secret []byte) context.Context {
	t.Helper()
	ch, err := h.svc.Login(t.Context(), email, staffPassword)
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	sess, err := h.svc.VerifyTOTP(t.Context(), ch.ID, h.code(secret))
	if err != nil {
		t.Fatalf("totp: %v", err)
	}
	ctx, err := h.svc.Authenticate(t.Context(), sess.AccessToken)
	if err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	// The next sign-in needs a fresh code: each step is good once.
	h.clock.Advance(30 * time.Second)
	return ctx
}

func (h *harness) count(t *testing.T, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := h.svc.pool.QueryRow(t.Context(), sql, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	return n
}

func wantProblem(t *testing.T, err error, want *problem.Error) {
	t.Helper()
	if !errors.Is(err, want) {
		t.Fatalf("err = %v, want %s (%d)", err, want.Code, want.Status)
	}
}
