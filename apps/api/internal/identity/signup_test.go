package identity

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"regexp"
	"sync"
	"testing"
	"time"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/mailer"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

// clock is a test clock that only moves when told to.
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

// inbox captures sent mail; fail makes the next sends error.
type inbox struct {
	mu   sync.Mutex
	sent []mailer.Message
	fail bool
}

func (b *inbox) Send(_ context.Context, m mailer.Message) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.fail {
		return errors.New("smtp down")
	}
	b.sent = append(b.sent, m)
	return nil
}

var codeRE = regexp.MustCompile(`\b\d{6}\b`)

// lastCode is the code in the latest email.
func (b *inbox) lastCode(t *testing.T) string {
	t.Helper()
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.sent) == 0 {
		t.Fatal("no email was sent")
	}
	return codeRE.FindString(b.sent[len(b.sent)-1].Text)
}

type harness struct {
	svc   *Service
	clock *clock
	inbox *inbox
}

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

// fastHash keeps argon2id cheap in tests; production parameters are checked by the hash
// format test.
var fastHash = Argon2Params{MemoryKiB: 64, Time: 1, Threads: 1}

func newHarness(t *testing.T) *harness {
	t.Helper()
	// Postgres keeps microseconds, so the clock does too: times round-trip exactly.
	h := &harness{clock: &clock{t: time.Now().Truncate(time.Microsecond)}, inbox: &inbox{}}
	svc, err := NewService(Config{
		Pool: testdb.New(t), Mailer: h.inbox, Logger: quiet,
		OTPKey: []byte("0123456789abcdef0123456789abcdef"), SigningKey: testSeed,
		Hasher: NewHasher(fastHash, 4), Now: h.clock.Now,
	})
	if err != nil {
		t.Fatal(err)
	}
	h.svc = svc
	return h
}

func details(email, phone string) SignupDetails {
	return SignupDetails{
		FirstName: "Tolu", LastName: "Adeyemi", Email: email, Phone: phone,
		DateOfBirth:  time.Date(1996, 4, 12, 0, 0, 0, 0, time.UTC),
		TermsVersion: "2026-10", PrivacyVersion: "2026-10", ConsentAcceptedAt: time.Now(),
	}
}

func wantProblem(t *testing.T, err error, want *problem.Error) {
	t.Helper()
	if !errors.Is(err, want) {
		t.Fatalf("err = %v, want %s (%d)", err, want.Code, want.Status)
	}
}

const strongPassword = "Kitchen-Mango-River-7"

func TestSignupFromDetailsToAccount(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	ctx := t.Context()

	started, err := h.svc.StartSignup(ctx, details("  Tolu@Example.com ", "+2348031234567"))
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	c := started.Challenge
	if c.Destination != "tolu@example.com" || c.AttemptsLeft != 5 || c.ExpiresAt.Sub(h.clock.Now()) != 10*time.Minute {
		t.Fatalf("challenge = %+v", c)
	}
	code := h.inbox.lastCode(t)

	_, err = h.svc.VerifyCode(ctx, c.ID, wrongCode(code))
	var p *problem.Error
	if !errors.As(err, &p) || p.Code != "invalid_otp" || p.Detail != "4 attempts left." {
		t.Fatalf("wrong code: err = %v", err)
	}
	v, err := h.svc.VerifyCode(ctx, c.ID, code)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	// A verified code cannot be replayed for a second token.
	_, err = h.svc.VerifyCode(ctx, c.ID, code)
	wantProblem(t, err, ErrOTPExpired)

	_, err = h.svc.CompleteSignup(ctx, started.SignupID, v.Token, "Tolu-Adeyemi-1996", "", phone(1))
	wantProblem(t, err, ErrWeakPassword)

	res, err := h.svc.CompleteSignup(ctx, started.SignupID, v.Token, strongPassword, "", phone(1))
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	user := res.User
	// The first device is trusted at once: there is no earlier device to protect.
	if res.Device.CoolOffUntil != nil || res.AccessToken == "" || res.RefreshToken == "" {
		t.Fatalf("session = %+v", res)
	}
	if user.Email != "tolu@example.com" || user.KycTier != 1 || user.PasswordHash == strongPassword {
		t.Fatalf("user = %+v", user)
	}
	if ok, err := h.svc.hasher.Verify(ctx, strongPassword, user.PasswordHash); err != nil || !ok {
		t.Fatalf("stored hash does not verify: %v", err)
	}

	// The token is single use, and the email and phone are now taken.
	_, err = h.svc.CompleteSignup(ctx, started.SignupID, v.Token, strongPassword, "", phone(2))
	wantProblem(t, err, ErrNotVerified)
	_, err = h.svc.StartSignup(ctx, details("tolu@example.com", "+2348039999999"))
	wantProblem(t, err, ErrEmailTaken)
	_, err = h.svc.StartSignup(ctx, details("other@example.com", "+2348031234567"))
	wantProblem(t, err, ErrPhoneTaken)
}

func TestSignupRefusesUnder18sInLagosTime(t *testing.T) {
	t.Parallel()
	h := newHarness(t)

	// 23:30 UTC on the eve of the 18th birthday is already the birthday in Lagos (UTC+1).
	h.clock.t = time.Date(2026, 4, 11, 23, 30, 0, 0, time.UTC)
	d := details("teen@example.com", "+2348031234567")
	d.DateOfBirth = time.Date(2008, 4, 12, 0, 0, 0, 0, time.UTC)
	d.ConsentAcceptedAt = h.clock.t
	if _, err := h.svc.StartSignup(t.Context(), d); err != nil {
		t.Fatalf("18 today in Lagos: %v", err)
	}
	d.Email, d.Phone = "younger@example.com", "+2348031234568"
	d.DateOfBirth = time.Date(2008, 4, 13, 0, 0, 0, 0, time.UTC)
	_, err := h.svc.StartSignup(t.Context(), d)
	wantProblem(t, err, ErrUnderage)
}

func TestCodesExpireAndLockAfterFiveWrongTries(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	ctx := t.Context()

	first, err := h.svc.StartSignup(ctx, details("a@example.com", "+2348031234567"))
	if err != nil {
		t.Fatal(err)
	}
	code := h.inbox.lastCode(t)
	for range 5 {
		_, err = h.svc.VerifyCode(ctx, first.Challenge.ID, wrongCode(code))
		wantProblem(t, err, ErrOTPInvalid)
	}
	// Out of attempts: even the right code is refused now.
	_, err = h.svc.VerifyCode(ctx, first.Challenge.ID, code)
	wantProblem(t, err, ErrOTPExhausted)

	second, err := h.svc.StartSignup(ctx, details("b@example.com", "+2348031234568"))
	if err != nil {
		t.Fatal(err)
	}
	h.clock.Advance(10 * time.Minute)
	_, err = h.svc.VerifyCode(ctx, second.Challenge.ID, h.inbox.lastCode(t))
	wantProblem(t, err, ErrOTPExpired)
}

func TestResendWaitsSixtySecondsAndReplacesTheCode(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	ctx := t.Context()

	started, err := h.svc.StartSignup(ctx, details("a@example.com", "+2348031234567"))
	if err != nil {
		t.Fatal(err)
	}
	oldCode := h.inbox.lastCode(t)
	_, err = h.svc.ResendCode(ctx, started.Challenge.ID)
	var p *problem.Error
	if !errors.As(err, &p) || p.Status != 429 || !p.RetryAt.Equal(started.Challenge.ResendAt) {
		t.Fatalf("early resend: err = %v", err)
	}

	h.clock.Advance(61 * time.Second)
	c, err := h.svc.ResendCode(ctx, started.Challenge.ID)
	if err != nil {
		t.Fatalf("resend: %v", err)
	}
	newCode := h.inbox.lastCode(t)
	if c.ID != started.Challenge.ID || c.AttemptsLeft != 5 {
		t.Fatalf("resent challenge = %+v", c)
	}
	if newCode != oldCode {
		_, err = h.svc.VerifyCode(ctx, c.ID, oldCode)
		wantProblem(t, err, ErrOTPInvalid)
	}
	if _, err := h.svc.VerifyCode(ctx, c.ID, newCode); err != nil {
		t.Fatalf("verify new code: %v", err)
	}
}

func TestOneAddressGetsAtMostFiveCodesAnHour(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	ctx := t.Context()

	for i := range 5 {
		if _, err := h.svc.StartSignup(ctx, details("a@example.com", "+2348031234567")); err != nil {
			t.Fatalf("start %d: %v", i+1, err)
		}
	}
	_, err := h.svc.StartSignup(ctx, details("A@example.com", "+2348031234567"))
	var p *problem.Error
	if !errors.Is(err, ErrTooManyCodes) || !errors.As(err, &p) || p.RetryAt.IsZero() {
		t.Fatalf("6th start: err = %v", err)
	}
	if _, err := h.svc.StartSignup(ctx, details("b@example.com", "+2348031234568")); err != nil {
		t.Fatalf("another address is not limited: %v", err)
	}
}

func TestAFailedSendIsA503(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	h.inbox.fail = true

	_, err := h.svc.StartSignup(t.Context(), details("a@example.com", "+2348031234567"))
	wantProblem(t, err, ErrEmailUnavailable)
}

// wrongCode is a 6-digit code that is not code.
func wrongCode(code string) string {
	if code == "000000" {
		return "000001"
	}
	return "000000"
}
