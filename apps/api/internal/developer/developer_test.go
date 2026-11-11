package developer

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/limits"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/fieldcrypt"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers"
)

type dbCustomers struct{ pool *pgxpool.Pool }

func (c dbCustomers) CustomerProfile(ctx context.Context, id uuid.UUID) (identity.CustomerProfile, error) {
	var p identity.CustomerProfile
	var first, last string
	err := c.pool.QueryRow(ctx, `SELECT first_name, last_name, nemtag, kyc_tier FROM users WHERE id = $1`, id).Scan(&first, &last, &p.Nemtag, &p.KycTier)
	p.Name = first + " " + last
	return p, err
}

func (c dbCustomers) FindCustomer(ctx context.Context, handle string) (uuid.UUID, error) {
	var id uuid.UUID
	if err := c.pool.QueryRow(ctx, `SELECT id FROM users WHERE '@' || nemtag = $1`, handle).Scan(&id); err != nil {
		return uuid.Nil, identity.ErrNoSuchCustomer
	}
	return id, nil
}

func (dbCustomers) CoolOff(context.Context) (identity.CoolOff, error) { return identity.CoolOff{}, nil }

// stepUps accepts the token "ok" for the purpose a key needs, any number of times.
type stepUps struct{}

func (stepUps) ConsumeStepUp(_ context.Context, _ pgx.Tx, _ uuid.UUID, purpose, token string) error {
	if purpose != stepUpPurpose || token != "ok" {
		return identity.ErrStepUpRequired
	}
	return nil
}

type fixture struct {
	t      *testing.T
	pool   *pgxpool.Pool
	svc    *Service
	xfers  *transfers.Service
	n      int
	mu     sync.Mutex
	now    time.Time
	remote *httptest.Server
	// What the receiver does: status to answer with, and what it saw.
	status int
	seen   []seenRequest
}

type seenRequest struct {
	Header http.Header
	Body   []byte
}

func (f *fixture) clock() time.Time { f.mu.Lock(); defer f.mu.Unlock(); return f.now }
func (f *fixture) advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.now = f.now.Add(d)
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	pool := testdb.New(t)
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	f := &fixture{t: t, pool: pool, now: time.Now().UTC().Truncate(time.Millisecond), status: 200}
	f.remote = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.seen = append(f.seen, seenRequest{Header: r.Header.Clone(), Body: b})
		st := f.status
		f.mu.Unlock()
		w.WriteHeader(st)
		_, _ = w.Write([]byte("receiver says\x00 hi"))
	}))
	t.Cleanup(f.remote.Close)
	keyring, err := fieldcrypt.New(map[uint16][]byte{1: []byte("0123456789abcdef0123456789abcdef")}, []byte("fedcba9876543210fedcba9876543210"))
	if err != nil {
		t.Fatal(err)
	}
	cust := dbCustomers{pool}
	accts, err := accounts.NewService(accounts.Config{Pool: pool, Customers: cust, Logger: quiet, Now: f.clock})
	if err != nil {
		t.Fatal(err)
	}
	lim, err := limits.NewService(limits.Config{Pool: pool, Customers: cust, Now: f.clock})
	if err != nil {
		t.Fatal(err)
	}
	if f.xfers, err = transfers.NewService(transfers.Config{Pool: pool, Accounts: accts, Customers: cust, Limits: lim, Logger: quiet, Now: f.clock}); err != nil {
		t.Fatal(err)
	}
	f.svc, err = NewService(Config{
		Pool: pool, Keyring: keyring, StepUps: stepUps{}, Transfers: f.xfers, HTTPClient: f.remote.Client(), AllowPrivateTargets: true,
		Logger: quiet, Now: f.clock,
	})
	if err != nil {
		t.Fatal(err)
	}
	return f
}

type person struct {
	ctx     context.Context
	id      uuid.UUID
	account uuid.UUID
}

func (f *fixture) customer(name string) person {
	f.t.Helper()
	ctx := f.t.Context()
	id := uuid.New()
	f.n++
	if _, err := f.pool.Exec(ctx, `INSERT INTO users (id, first_name, last_name, email, phone, nemtag, date_of_birth,
		password_hash, kyc_tier, terms_version, privacy_version, consent_accepted_at)
		VALUES ($1, $2, 'Test', $3, $4, $5, '1985-04-12', 'x', 3, '2026-10', '2026-10', now())`,
		id, name, fmt.Sprintf("d%d@example.com", f.n), fmt.Sprintf("+2348034%06d", f.n), fmt.Sprintf("dev%d", f.n)); err != nil {
		f.t.Fatal(err)
	}
	if err := pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		return accounts.OpenCurrentAccount(ctx, tx, identity.NewCustomer{UserID: id, Name: name + " Test"})
	}); err != nil {
		f.t.Fatal(err)
	}
	p := person{id: id, ctx: identity.WithPrincipal(ctx, identity.Principal{UserID: id, DeviceID: uuid.New()})}
	if err := f.pool.QueryRow(ctx, `SELECT account_id FROM customer_accounts WHERE user_id = $1 AND currency = 'NGN'`, id).Scan(&p.account); err != nil {
		f.t.Fatal(err)
	}
	return p
}

func (f *fixture) count(sql string, args ...any) int {
	f.t.Helper()
	var n int
	if err := f.pool.QueryRow(f.t.Context(), sql, args...).Scan(&n); err != nil {
		f.t.Fatalf("%s: %v", sql, err)
	}
	return n
}

func (f *fixture) requests() []seenRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]seenRequest(nil), f.seen...)
}

func (f *fixture) respondWith(status int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.status = status
}

func wantStatus(t *testing.T, err error, status int) {
	t.Helper()
	var p *problem.Error
	if !errors.As(err, &p) || p.Status != status {
		t.Fatalf("err = %v, want a %d problem", err, status)
	}
}

// fund puts kobo on a customer account from the bank's demo funding account.
func fund(t *testing.T, f *fixture, account uuid.UUID, kobo int64) {
	t.Helper()
	ctx := t.Context()
	if err := pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		src, err := ledger.SystemAccount(ctx, tx, ledger.KindDemoFunding, "NGN")
		if err != nil {
			return err
		}
		m := money.New(kobo, money.NGN)
		_, err = ledger.Post(ctx, tx, ledger.Entry{Kind: "demo_funding", Reference: "seed-" + uuid.NewString(), Legs: []ledger.Leg{ledger.Debit(src.ID, m), ledger.Credit(account, m)}})
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

// toNemTag is a transfer destination: the Nem account with this ID.
func toNemTag(t *testing.T, f *fixture, account uuid.UUID) api.TransferDestination {
	t.Helper()
	var number string
	if err := f.pool.QueryRow(t.Context(), `SELECT account_number FROM customer_accounts WHERE account_id = $1`, account).Scan(&number); err != nil {
		t.Fatal(err)
	}
	var d api.TransferDestination
	if err := d.FromNemDestination(api.NemDestination{Kind: "nem", AccountNumber: number}); err != nil {
		t.Fatal(err)
	}
	return d
}

func mustMarshal(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func (f *fixture) endpoint(p person, events ...api.WebhookEventType) (api.WebhookEndpoint, string) {
	f.t.Helper()
	if len(events) == 0 {
		events = []api.WebhookEventType{"transfer.completed", "test.ping", "payment_link.paid"}
	}
	e, secret, err := f.svc.CreateEndpoint(p.ctx, api.CreateWebhookEndpointRequest{Url: f.remote.URL + "/hook", Events: events})
	if err != nil {
		f.t.Fatal(err)
	}
	return endpointJSON(e), secret
}

var keyShape = regexp.MustCompile(`^nem_test_[A-Za-z0-9]{32}$`)
var hookShape = regexp.MustCompile(`^whsec_[A-Za-z0-9]{32}$`)

func TestAPIKeysAreShownOnceScopedAndRevocable(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	dev, other := f.customer("Dev"), f.customer("Other")

	k, secret, err := f.svc.CreateKey(dev.ctx, "CI key", []string{"accounts_read", "webhooks_manage"}, "ok")
	if err != nil || !keyShape.MatchString(secret) || k.Prefix != secret[:13] {
		t.Fatalf("create = %+v, %q, %v", k, secret, err)
	}
	// Only a hash is stored: the secret is nowhere in the table.
	if f.count(`SELECT count(*) FROM api_keys WHERE key_hash = sha256($1::bytea)`, secret) != 1 || f.count(`SELECT count(*) FROM api_keys WHERE prefix || name LIKE '%' || $1 || '%'`, secret[13:]) != 0 {
		t.Fatal("the key is not stored as a hash only")
	}
	if _, _, err := f.svc.CreateKey(dev.ctx, "No step-up", []string{"accounts_read"}, ""); err == nil {
		t.Fatal("a key was made without a step-up")
	}
	for name, scopes := range map[string][]string{"none": nil, "unknown": {"root"}, "twice": {"accounts_read", "accounts_read"}} {
		if _, _, err := f.svc.CreateKey(dev.ctx, "Bad", scopes, "ok"); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}

	// The key authenticates as its owner, with its scopes.
	ctx, err := f.svc.Authenticate(t.Context(), secret)
	if err != nil {
		t.Fatal(err)
	}
	p, _ := identity.PrincipalFrom(ctx)
	got, ok := KeyFrom(ctx)
	if p.UserID != dev.id || !ok || !got.Has("accounts_read") || got.Has("payment_links_write") {
		t.Fatalf("principal %v, key %+v", p, got)
	}
	// A key cannot mint or revoke keys: that is a signed-in customer's job.
	if _, _, err := f.svc.CreateKey(ctx, "Escalate", []string{"accounts_read"}, "ok"); err == nil {
		t.Fatal("a key created a key")
	}
	if f.count(`SELECT count(*) FROM api_keys WHERE last_used_at IS NOT NULL`) != 1 {
		t.Fatal("use was not recorded")
	}

	// Junk and near-misses are the same plain 401.
	for _, bad := range []string{"", "nem_test_short", "nem_live_" + secret[9:], secret[:40] + "x", "Bearer " + secret} {
		if _, err := f.svc.Authenticate(t.Context(), bad); err == nil {
			t.Errorf("%q authenticated", bad)
		}
	}

	// Someone else's key id is "not found"; mine goes, and revoking twice is fine.
	wantStatus(t, f.svc.RevokeKey(other.ctx, k.ID), 404)
	if err := f.svc.RevokeKey(dev.ctx, k.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.RevokeKey(dev.ctx, k.ID); err != nil {
		t.Fatalf("second revoke: %v", err)
	}
	if _, err := f.svc.Authenticate(t.Context(), secret); err == nil {
		t.Fatal("a revoked key still works")
	}
	list, err := f.svc.Keys(dev.ctx)
	if err != nil || len(list) != 1 || list[0].RevokedAt == nil {
		t.Fatalf("list = %+v, %v", list, err)
	}
	if others, _ := f.svc.Keys(other.ctx); len(others) != 0 {
		t.Fatal("another customer's keys are visible")
	}

	// A frozen customer's keys stop working too.
	_, live, err := f.svc.CreateKey(dev.ctx, "Live one", []string{"accounts_read"}, "ok")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE users SET frozen_at = now(), frozen_reason = 'test' WHERE id = $1`, dev.id); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Authenticate(t.Context(), live); err == nil {
		t.Fatal("a frozen customer's key works")
	}
}

func TestEndpointURLsMustBePublicHTTPS(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	f.svc.private = false // the fixture's own test server is local; here the real rules apply
	dev := f.customer("Dev")
	for _, u := range []string{
		"http://example.com/hook", "https://localhost/hook", "https://127.0.0.1/hook", "https://10.0.0.5/hook", "https://169.254.169.254/latest",
		"https://[::1]/hook", "https://user:pass@example.com/hook", "https://service.internal/hook", "ftp://example.com", "not a url", "https://192.168.1.1/",
		"https://100.64.0.1/",
	} {
		_, _, err := f.svc.CreateEndpoint(dev.ctx, api.CreateWebhookEndpointRequest{Url: u, Events: []api.WebhookEventType{"test.ping"}})
		if err == nil {
			t.Errorf("%q was accepted", u)
		}
	}
	if _, _, err := f.svc.CreateEndpoint(dev.ctx, api.CreateWebhookEndpointRequest{Url: "https://hooks.example.com/nem", Events: []api.WebhookEventType{"test.ping"}}); err != nil {
		t.Fatalf("a public URL was refused: %v", err)
	}
	if _, _, err := f.svc.CreateEndpoint(dev.ctx, api.CreateWebhookEndpointRequest{Url: "https://hooks.example.com/x", Events: []api.WebhookEventType{"made.up"}}); err == nil {
		t.Error("an unknown event was accepted")
	}
	// The dialler refuses internal addresses even when a name resolves to one.
	for _, ip := range []string{"127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.9", "169.254.169.254", "100.64.9.9", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1"} {
		a, err := netip.ParseAddr(ip)
		if err != nil || !blocked(a) {
			t.Errorf("%s is not blocked", ip)
		}
	}
	for _, ip := range []string{"8.8.8.8", "2606:4700:4700::1111"} {
		if a, _ := netip.ParseAddr(ip); blocked(a) {
			t.Errorf("%s is blocked", ip)
		}
	}
}

func TestADeliveryIsSignedAndASecondSecretSignsDuringRotation(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	dev, other := f.customer("Dev"), f.customer("Other")
	ep, secret := f.endpoint(dev)
	if !hookShape.MatchString(secret) || ep.SecretPrefix != secret[:10] || ep.Status != "active" {
		t.Fatalf("endpoint %+v secret %q", ep, secret)
	}
	if _, err := f.svc.Endpoint(other.ctx, ep.Id); err == nil {
		t.Fatal("another customer can see the endpoint")
	}

	d, err := f.svc.SendTest(dev.ctx, ep.Id)
	if err != nil || d.Status != "pending" || d.EventType != "test.ping" {
		t.Fatalf("test = %+v, %v", d, err)
	}
	if err := f.svc.Attempt(t.Context(), d.Id); err != nil {
		t.Fatal(err)
	}
	seen := f.requests()
	if len(seen) != 1 {
		t.Fatalf("receiver saw %d requests", len(seen))
	}
	r := seen[0]
	if r.Header.Get("Nem-Event-Id") != d.EventId.String() || r.Header.Get("Nem-Event-Type") != "test.ping" || !strings.HasPrefix(r.Header.Get("User-Agent"), "NemBank-Webhooks") {
		t.Fatalf("headers = %v", r.Header)
	}
	var ev api.WebhookEvent
	if err := json.Unmarshal(r.Body, &ev); err != nil || ev.Id != d.EventId || ev.Type != "test.ping" || ev.Livemode {
		t.Fatalf("body = %s (%v)", r.Body, err)
	}
	verify := func(header, sec string) bool {
		var ts string
		var sigs []string
		for _, part := range strings.Split(header, ",") {
			k, v, _ := strings.Cut(part, "=")
			switch k {
			case "t":
				ts = v
			case "v1":
				sigs = append(sigs, v)
			}
		}
		m := hmac.New(sha256.New, []byte(sec))
		m.Write([]byte(ts + "." + string(r.Body)))
		want := hex.EncodeToString(m.Sum(nil))
		for _, s := range sigs {
			if hmac.Equal([]byte(s), []byte(want)) {
				return true
			}
		}
		return false
	}
	if !verify(r.Header.Get("Nem-Signature"), secret) {
		t.Fatalf("signature does not verify: %s", r.Header.Get("Nem-Signature"))
	}
	logged, _, err := f.svc.Deliveries(dev.ctx, ep.Id, nil, nil, nil)
	if err != nil || len(logged) != 1 || logged[0].Status != "succeeded" || logged[0].ResponseStatus == nil || *logged[0].ResponseStatus != 200 || logged[0].DurationMs == nil {
		t.Fatalf("log = %+v, %v", logged, err)
	}
	// The receiver's reply is kept as a safe excerpt: control characters are gone.
	if logged[0].ResponseBodyExcerpt == nil || strings.ContainsRune(*logged[0].ResponseBodyExcerpt, 0) {
		t.Fatalf("excerpt = %v", logged[0].ResponseBodyExcerpt)
	}

	// Rotating: the new secret signs, and the old one keeps signing alongside for a day.
	rotated, newSecret, err := f.svc.RotateSecret(dev.ctx, ep.Id)
	if err != nil || newSecret == secret || rotated.SecretPrefix != newSecret[:10] {
		t.Fatalf("rotate = %+v, %v", rotated, err)
	}
	d2, _ := f.svc.SendTest(dev.ctx, ep.Id)
	if err := f.svc.Attempt(t.Context(), d2.Id); err != nil {
		t.Fatal(err)
	}
	r = f.requests()[1]
	if !verify(r.Header.Get("Nem-Signature"), newSecret) || !verify(r.Header.Get("Nem-Signature"), secret) {
		t.Fatalf("during rotation both secrets should verify: %s", r.Header.Get("Nem-Signature"))
	}
	f.advance(25 * time.Hour)
	d3, _ := f.svc.SendTest(dev.ctx, ep.Id)
	if err := f.svc.Attempt(t.Context(), d3.Id); err != nil {
		t.Fatal(err)
	}
	r = f.requests()[2]
	if !verify(r.Header.Get("Nem-Signature"), newSecret) || verify(r.Header.Get("Nem-Signature"), secret) {
		t.Fatalf("after 24 hours only the new secret should sign: %s", r.Header.Get("Nem-Signature"))
	}
	// The secret is stored encrypted, never as text.
	if f.count(`SELECT count(*) FROM webhook_endpoints WHERE position(convert_to($1, 'UTF8') in secret_ciphertext) > 0`, newSecret) != 0 {
		t.Fatal("a signing secret is stored in the clear")
	}
}

func TestFailedDeliveriesRetryWithBackoffThenFailAndCanBeReplayed(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	dev := f.customer("Dev")
	ep, _ := f.endpoint(dev)
	f.respondWith(500)

	d, err := f.svc.SendTest(dev.ctx, ep.Id)
	if err != nil {
		t.Fatal(err)
	}
	wait := []time.Duration{time.Minute, 5 * time.Minute, 30 * time.Minute, 2 * time.Hour, 6 * time.Hour, 12 * time.Hour, 24 * time.Hour}
	for i, w := range wait {
		if err := f.svc.Attempt(t.Context(), d.Id); err != nil {
			t.Fatal(err)
		}
		cur, _, _ := f.svc.Deliveries(dev.ctx, ep.Id, nil, nil, nil)
		got := cur[0]
		if got.Status != "retrying" || got.Attempt != i+1 || got.NextRetryAt == nil {
			t.Fatalf("after attempt %d: %+v", i+1, got)
		}
		if gap := got.NextRetryAt.Sub(f.clock()); gap < w-time.Second || gap > w+time.Second {
			t.Fatalf("attempt %d retries in %s, want %s", i+1, gap, w)
		}
		f.advance(w)
	}
	// The eighth try is the last.
	if err := f.svc.Attempt(t.Context(), d.Id); err != nil {
		t.Fatal(err)
	}
	cur, _, _ := f.svc.Deliveries(dev.ctx, ep.Id, nil, nil, nil)
	if cur[0].Status != "failed" || cur[0].Attempt != 8 || cur[0].NextRetryAt != nil || len(f.requests()) != 8 {
		t.Fatalf("final = %+v after %d requests", cur[0], len(f.requests()))
	}
	// A finished delivery is not tried again by a stray job.
	if err := f.svc.Attempt(t.Context(), d.Id); err != nil || len(f.requests()) != 8 {
		t.Fatalf("a failed delivery was retried: %v", err)
	}
	// Eight failures in under two days do not switch it off; three days of failing does.
	after, _ := f.svc.Endpoint(dev.ctx, ep.Id)
	if after.Status != "active" || after.ConsecutiveFailures != 8 {
		t.Fatalf("endpoint = %s with %d failures", after.Status, after.ConsecutiveFailures)
	}
	f.advance(72 * time.Hour)
	more, _ := f.svc.SendTest(dev.ctx, ep.Id)
	if err := f.svc.Attempt(t.Context(), more.Id); err != nil {
		t.Fatal(err)
	}
	if after, _ = f.svc.Endpoint(dev.ctx, ep.Id); after.Status != "disabled" {
		t.Fatalf("after three days of failures the endpoint is %s", after.Status)
	}
	// A disabled endpoint gets nothing: a stray delivery is ended without a call.
	called := len(f.requests())
	stray, _ := f.svc.Replay(dev.ctx, d.Id)
	if err := f.svc.Attempt(t.Context(), stray.Id); err != nil || len(f.requests()) != called {
		t.Fatalf("a disabled endpoint was called: %v", err)
	}

	// Replay: same event, new delivery. Switching the endpoint back on and fixing the receiver works.
	back := api.UpdateWebhookEndpointRequestStatus("active")
	if _, err := f.svc.UpdateEndpoint(dev.ctx, ep.Id, api.UpdateWebhookEndpointRequest{Status: &back}); err != nil {
		t.Fatal(err)
	}
	f.respondWith(200)
	again, err := f.svc.Replay(dev.ctx, d.Id)
	if err != nil || again.Id == d.Id || again.EventId != d.EventId || again.Attempt != 1 || again.Status != "pending" {
		t.Fatalf("replay = %+v, %v", again, err)
	}
	if err := f.svc.Attempt(t.Context(), again.Id); err != nil {
		t.Fatal(err)
	}
	last := f.requests()[len(f.requests())-1]
	if last.Header.Get("Nem-Event-Id") != d.EventId.String() || string(last.Body) != string(f.requests()[0].Body) {
		t.Fatal("a replay must resend the same event and bytes")
	}
	if e, _ := f.svc.Endpoint(dev.ctx, ep.Id); e.ConsecutiveFailures != 0 {
		t.Fatalf("a success should clear the failures: %d", e.ConsecutiveFailures)
	}
	wantStatus(t, func() error { _, err := f.svc.Replay(f.customer("Other").ctx, d.Id); return err }(), 404)
}

func TestDeletingAnEndpointCancelsWhatWasWaiting(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	dev := f.customer("Dev")
	ep, _ := f.endpoint(dev)
	d, _ := f.svc.SendTest(dev.ctx, ep.Id)
	if err := f.svc.DeleteEndpoint(dev.ctx, ep.Id); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.Attempt(t.Context(), d.Id); err != nil || len(f.requests()) != 0 {
		t.Fatalf("a deleted endpoint was called: %v", err)
	}
	if f.count(`SELECT count(*) FROM webhook_deliveries WHERE id = $1 AND status = 'failed'`, d.Id) != 1 {
		t.Fatal("the waiting delivery was not cancelled")
	}
	wantStatus(t, f.svc.DeleteEndpoint(dev.ctx, ep.Id), 404)
	if _, err := f.svc.Endpoint(dev.ctx, ep.Id); err == nil {
		t.Fatal("a deleted endpoint is still there")
	}
}

func TestBankEventsBecomeDeliveriesOnlyForSubscribedEndpointsAndOnlyOnce(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	dev, bob := f.customer("Dev"), f.customer("Bob")
	fund(t, f, bob.account, 5_000_000)

	mine, _ := f.endpoint(dev, "transfer.completed")
	_, _ = f.endpoint(dev, "payment_link.paid") // listens for something else
	bobs, _ := f.endpoint(bob, "transfer.completed")

	v, err := f.xfers.Create(bob.ctx, transfers.Request{SourceAccountID: bob.account, Destination: toNemTag(t, f, dev.account), Amount: money.New(100_000, money.NGN), Narration: "Invoice 7"})
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]any{"transfer_id": v.ID, "user_id": bob.id, "recipient_user_id": dev.id, "rail": "internal"})
	ev := jobs.Delivery{ID: uuid.New(), Topic: "transfer.completed", AggregateType: "transfer", AggregateID: v.ID.String(), Payload: payload, CreatedAt: f.clock()}
	for range 2 { // the outbox can hand the same event over twice
		if err := f.svc.dispatch(t.Context(), ev); err != nil {
			t.Fatal(err)
		}
	}
	// Bob (the sender) is told transfer.completed; Dev (the receiver) is not subscribed to account.credited.
	bobLog, _, _ := f.svc.Deliveries(bob.ctx, bobs.Id, nil, nil, nil)
	devLog, _, _ := f.svc.Deliveries(dev.ctx, mine.Id, nil, nil, nil)
	if len(bobLog) != 1 || bobLog[0].EventType != "transfer.completed" || len(devLog) != 0 {
		t.Fatalf("bob %d, dev %d deliveries", len(bobLog), len(devLog))
	}
	var body struct {
		Data struct {
			Object struct {
				ID        uuid.UUID `json:"id"`
				Narration string    `json:"narration"`
			} `json:"object"`
		} `json:"data"`
	}
	raw, _ := json.Marshal(bobLog[0].RequestBody)
	if err := json.Unmarshal(raw, &body); err != nil || body.Data.Object.ID != v.ID || body.Data.Object.Narration != "Invoice 7" {
		t.Fatalf("event object = %s (%v)", raw, err)
	}

	// A disabled endpoint receives nothing new.
	off := api.UpdateWebhookEndpointRequestStatus("disabled")
	if _, err := f.svc.UpdateEndpoint(bob.ctx, bobs.Id, api.UpdateWebhookEndpointRequest{Status: &off}); err != nil {
		t.Fatal(err)
	}
	ev.ID = uuid.New()
	if err := f.svc.dispatch(t.Context(), ev); err != nil {
		t.Fatal(err)
	}
	if got, _, _ := f.svc.Deliveries(bob.ctx, bobs.Id, nil, nil, nil); len(got) != 1 {
		t.Fatalf("a disabled endpoint got %d deliveries", len(got))
	}
}

func TestASandboxPaymentCreditsTheLinkAndFiresPaymentLinkPaid(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	dev, other := f.customer("Dev"), f.customer("Other")
	ep, _ := f.endpoint(dev, "payment_link.paid")

	link, err := f.xfers.CreateLink(dev.ctx, transfers.NewLink{AccountID: dev.account, Title: "Coffee", AmountMode: "open"})
	if err != nil {
		t.Fatal(err)
	}
	amt := &api.Money{AmountMinor: "250000", Currency: "NGN"}
	tr, err := f.xfers.SandboxLinkPayment(dev.ctx, dev.id, link.ID, amt, "Ngozi")
	if err != nil || tr.Status != "completed" || tr.Amount.AmountMinor != "250000" {
		t.Fatalf("payment = %+v, %v", tr, err)
	}
	var balance int64
	if err := f.pool.QueryRow(t.Context(), `SELECT balance_minor FROM ledger_accounts WHERE id = $1`, dev.account).Scan(&balance); err != nil || balance != 250_000 {
		t.Fatalf("balance = %d, %v", balance, err)
	}
	var count int
	var total int64
	if err := f.pool.QueryRow(t.Context(), `SELECT payments_count, total_received_minor FROM payment_links WHERE id = $1`, link.ID).Scan(&count, &total); err != nil || count != 1 || total != 250_000 {
		t.Fatalf("link takings = %d / %d, %v", count, total, err)
	}
	if f.count(`SELECT count(*) FROM transactions WHERE user_id = $1 AND narration = 'Coffee'`, dev.id) != 1 {
		t.Fatal("the credit is not in the owner's history")
	}
	// The same event reaches the endpoint, with the link as its object.
	var topic string
	var payload []byte
	if err := f.pool.QueryRow(t.Context(), `SELECT topic, payload FROM outbox_events WHERE topic = 'payment_link.paid'`).Scan(&topic, &payload); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.dispatch(t.Context(), jobs.Delivery{ID: uuid.New(), Topic: topic, Payload: payload, CreatedAt: f.clock()}); err != nil {
		t.Fatal(err)
	}
	log, _, _ := f.svc.Deliveries(dev.ctx, ep.Id, nil, nil, nil)
	if len(log) != 1 || log[0].EventType != "payment_link.paid" || !strings.Contains(string(mustMarshal(t, log[0].RequestBody)), "Coffee") {
		t.Fatalf("deliveries = %+v", log)
	}

	// An open link needs an amount; someone else's link, a closed one or a bad amount is refused.
	if _, err := f.xfers.SandboxLinkPayment(dev.ctx, dev.id, link.ID, nil, ""); err == nil {
		t.Fatal("an open link took no amount")
	}
	wantStatus(t, func() error { _, err := f.xfers.SandboxLinkPayment(other.ctx, other.id, link.ID, amt, ""); return err }(), 404)
	if _, err := f.xfers.SandboxLinkPayment(dev.ctx, dev.id, link.ID, &api.Money{AmountMinor: "-5", Currency: "NGN"}, ""); err == nil {
		t.Fatal("a negative payment was accepted")
	}
	if _, err := f.xfers.SandboxLinkPayment(dev.ctx, dev.id, link.ID, &api.Money{AmountMinor: "100", Currency: "USD"}, ""); err == nil {
		t.Fatal("a dollar payment was accepted")
	}
}
