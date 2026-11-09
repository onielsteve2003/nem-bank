package partners

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

var testSecret = []byte("sandbox-nip-test-secret-0123456789") // gitleaks:allow (test fixture)

// receiver is the callback endpoint: it checks the signature like the real webhook will.
type receiver struct {
	mu     sync.Mutex
	status int
	got    []api.PartnerCallback
	ids    []string
}

func (rc *receiver) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	if err := Verify(testSecret, r.Header.Get("Partner-Signature"), body, time.Now()); err != nil {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	var cb api.PartnerCallback
	_ = json.Unmarshal(body, &cb)
	rc.mu.Lock()
	defer rc.mu.Unlock()
	rc.got = append(rc.got, cb)
	rc.ids = append(rc.ids, r.Header.Get("Partner-Event-Id"))
	if rc.status != 0 {
		w.WriteHeader(rc.status)
	}
}

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

type sandboxFixture struct {
	pool  *pgxpool.Pool
	nip   *SandboxNIP
	clock *clock
	rc    *receiver
	staff uuid.UUID
}

func newSandbox(t *testing.T) *sandboxFixture {
	t.Helper()
	pool := testdb.New(t)
	f := &sandboxFixture{pool: pool, clock: &clock{t: time.Now()}, rc: &receiver{}, staff: uuid.New()}
	srv := httptest.NewServer(f.rc)
	t.Cleanup(srv.Close)
	var err error
	f.nip, err = NewSandboxNIP(SandboxConfig{Pool: pool, CallbackURL: srv.URL, Secret: testSecret, Now: f.clock.now})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO staff (id, name, email, password_hash, roles, totp_secret)
		VALUES ($1, 'Ngozi Admin', 'ngozi@nem.example', 'x', '{admin}', '\x00')`, f.staff); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *sandboxFixture) set(t *testing.T, s Settings) {
	t.Helper()
	if _, err := f.nip.SetSettings(t.Context(), f.staff, "Ngozi Admin", s); err != nil {
		t.Fatal(err)
	}
}

func payment(ref string) Payment {
	return Payment{Reference: ref, BankCode: "058", AccountNumber: "0123456789", AccountName: "Chidi Okonkwo",
		Amount: money.New(250_000, money.NGN), Narration: "Rent"}
}

func TestSandboxSettlesAfterTheDelayAndCallsBackOnce(t *testing.T) {
	t.Parallel()
	f := newSandbox(t)
	f.set(t, Settings{MinDelaySeconds: 5, MaxDelaySeconds: 5, NameCheck: Realistic})
	ctx := t.Context()

	sub, err := f.nip.Send(ctx, payment("NEM20261109AAAAAA"))
	if err != nil || len(sub.PartnerReference) != 30 {
		t.Fatalf("send = %+v, %v", sub, err)
	}
	// A resend is the same payment: same session ID, nothing new drawn or scheduled.
	again, err := f.nip.Send(ctx, payment("NEM20261109AAAAAA"))
	if err != nil || again != sub {
		t.Fatalf("resend = %+v, %v; want %+v", again, err, sub)
	}
	var rows, jobs int
	if err := f.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM sandbox_nip_payments),
		(SELECT count(*) FROM river_job WHERE kind = 'sandbox_nip_callback')`).Scan(&rows, &jobs); err != nil || rows != 1 || jobs != 1 {
		t.Fatalf("payments %d, callback jobs %d, %v", rows, jobs, err)
	}

	// Before the delay: pending, and an early callback job does not call back.
	if r, err := f.nip.Status(ctx, "NEM20261109AAAAAA"); err != nil || r.State != Pending {
		t.Fatalf("status before the delay = %+v, %v", r, err)
	}
	if err := f.nip.DeliverCallback(ctx, "NEM20261109AAAAAA"); err == nil || len(f.rc.got) != 0 {
		t.Fatalf("early callback: err %v, %d delivered (want a snooze, none sent)", err, len(f.rc.got))
	}

	f.clock.add(5 * time.Second)
	r, err := f.nip.Status(ctx, "NEM20261109AAAAAA")
	if err != nil || r.State != Settled || r.PartnerReference != sub.PartnerReference {
		t.Fatalf("status after the delay = %+v, %v", r, err)
	}
	for range 2 { // the second run finds it sent and does nothing
		if err := f.nip.DeliverCallback(ctx, "NEM20261109AAAAAA"); err != nil {
			t.Fatal(err)
		}
	}
	if len(f.rc.got) != 1 || f.rc.got[0].EventType != api.PartnerCallbackEventTypeTransferSettled ||
		f.rc.got[0].Reference != "NEM20261109AAAAAA" || f.rc.got[0].Amount.AmountMinor != "250000" ||
		f.rc.ids[0] != sub.PartnerReference+":settled" {
		t.Fatalf("callbacks = %+v, ids %v", f.rc.got, f.rc.ids)
	}
	if r, _ := f.nip.Status(ctx, "NEM20261109ZZZZZZ"); r.State != Unknown {
		t.Fatalf("unknown reference = %+v", r)
	}
}

func TestSandboxFailuresAndTimeouts(t *testing.T) {
	t.Parallel()
	f := newSandbox(t)
	ctx := t.Context()

	f.set(t, Settings{FailureRateBps: 10_000, NameCheck: Realistic})
	if _, err := f.nip.Send(ctx, payment("NEM20261109FAILED")); err != nil {
		t.Fatal(err)
	}
	r, err := f.nip.Status(ctx, "NEM20261109FAILED")
	if err != nil || r.State != Failed || r.FailureCode == "" {
		t.Fatalf("failed payment = %+v, %v", r, err)
	}
	// A receiver that is down gets the callback again later (River retries the error).
	f.rc.status = http.StatusServiceUnavailable
	if err := f.nip.DeliverCallback(ctx, "NEM20261109FAILED"); err == nil {
		t.Fatal("a 503 from the receiver was taken as delivered")
	}
	f.rc.status = 0
	if err := f.nip.DeliverCallback(ctx, "NEM20261109FAILED"); err != nil {
		t.Fatal(err)
	}
	last := f.rc.got[len(f.rc.got)-1]
	if last.EventType != api.PartnerCallbackEventTypeTransferFailed || last.FailureCode == nil || *last.FailureCode != r.FailureCode {
		t.Fatalf("failure callback = %+v", last)
	}

	f.set(t, Settings{TimeoutRateBps: 10_000, MaxDelaySeconds: 1, NameCheck: Realistic})
	if _, err := f.nip.Send(ctx, payment("NEM20261109TIMOUT")); err != nil {
		t.Fatal(err)
	}
	f.clock.add(time.Hour)
	if r, _ := f.nip.Status(ctx, "NEM20261109TIMOUT"); r.State != Pending {
		t.Fatalf("a timed-out payment answered %+v", r)
	}
	var jobs int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE kind = 'sandbox_nip_callback'
		AND args->>'reference' = 'NEM20261109TIMOUT'`).Scan(&jobs); err != nil || jobs != 0 {
		t.Fatalf("a timeout scheduled %d callbacks, %v", jobs, err)
	}

	// The rail refuses what NIP would refuse at the door.
	if _, err := f.nip.Send(ctx, Payment{Reference: "NEM20261109NOACCT", BankCode: "044", AccountNumber: "1234560000",
		Amount: money.New(100, money.NGN)}); !errors.Is(err, ErrAccountNotFound) {
		t.Fatalf("send to a missing account: %v", err)
	}
	if _, err := f.nip.Send(ctx, Payment{Reference: "NEM20261109DOLLAR", BankCode: "058", AccountNumber: "0123456789",
		Amount: money.New(100, money.USD)}); !errors.Is(err, ErrRejected) {
		t.Fatalf("send in dollars: %v", err)
	}
}

func TestSimulatorSettingsAreValidatedAndAudited(t *testing.T) {
	t.Parallel()
	f := newSandbox(t)
	ctx := t.Context()
	if s, err := f.nip.Settings(ctx); err != nil || s != DefaultSettings {
		t.Fatalf("seeded settings = %+v, %v", s, err)
	}
	f.set(t, Settings{FailureRateBps: 500, MinDelaySeconds: 2, MaxDelaySeconds: 30, NameCheck: AlwaysNoMatch, TimeoutRateBps: 100})
	if s, _ := f.nip.Settings(ctx); s.NameCheck != AlwaysNoMatch || s.MaxDelaySeconds != 30 {
		t.Fatalf("saved settings = %+v", s)
	}
	if n, err := f.nip.NameEnquiry(ctx, "058", "0123456789"); err != nil || n.NameCheck != AlwaysNoMatch {
		t.Fatalf("name enquiry carries the name check: %+v, %v", n, err)
	}
	var action string
	if err := f.pool.QueryRow(ctx, `SELECT action FROM audit_log WHERE resource_type = 'simulator' ORDER BY seq DESC LIMIT 1`).Scan(&action); err != nil ||
		action != "simulator.bank_partner.update" {
		t.Fatalf("audit = %q, %v", action, err)
	}

	for name, s := range map[string]Settings{
		"min above max":            {MinDelaySeconds: 10, MaxDelaySeconds: 5, NameCheck: Realistic},
		"failures and timeouts >1": {FailureRateBps: 6000, TimeoutRateBps: 5000, NameCheck: Realistic},
	} {
		_, err := f.nip.SetSettings(ctx, f.staff, "Ngozi Admin", s)
		var p *problem.Error
		if !errors.As(err, &p) || p.Code != problem.CodeValidationFailed {
			t.Errorf("%s: %v", name, err)
		}
	}
}
