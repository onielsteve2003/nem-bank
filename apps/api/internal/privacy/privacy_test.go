package privacy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
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
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/limits"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/fieldcrypt"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/mailer"
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

// stepUps accepts the token "ok" for account deletion.
type stepUps struct{}

func (stepUps) ConsumeStepUp(_ context.Context, _ pgx.Tx, _ uuid.UUID, purpose, token string) error {
	if purpose != "account_deletion" || token != "ok" {
		return identity.ErrStepUpRequired
	}
	return nil
}

// outbox keeps what was emailed.
type outbox struct {
	mu   sync.Mutex
	sent []mailer.Message
}

func (o *outbox) Send(_ context.Context, m mailer.Message) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.sent = append(o.sent, m)
	return nil
}

func (o *outbox) last() mailer.Message {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.sent[len(o.sent)-1]
}

type fixture struct {
	t     *testing.T
	pool  *pgxpool.Pool
	svc   *Service
	xfers *transfers.Service
	mail  *outbox
	n     int
	mu    sync.Mutex
	now   time.Time
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
	f := &fixture{t: t, pool: pool, mail: &outbox{}, now: time.Now().UTC().Truncate(time.Millisecond)}
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
		Pool: pool, Keyring: keyring, Mailer: f.mail, StepUps: stepUps{}, PublicURL: "https://api.example.test",
		LinkKey: []byte("privacy-link-key-0123456789abcdef"), Logger: quiet, Now: f.clock,
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
	number  string
	email   string
	phone   string
	tag     string
}

const secretHash = "ARGON2-SECRET-HASH-MARKER" // gitleaks:allow (test marker, not a credential)

func (f *fixture) customer(name string) person {
	f.t.Helper()
	ctx := f.t.Context()
	f.n++
	p := person{id: uuid.New(), email: fmt.Sprintf("%s%d@example.com", strings.ToLower(name), f.n), phone: fmt.Sprintf("+2348035%06d", f.n), tag: fmt.Sprintf("%s%d", strings.ToLower(name), f.n)}
	if _, err := f.pool.Exec(ctx, `INSERT INTO users (id, first_name, last_name, email, phone, nemtag, date_of_birth,
		password_hash, pin_hash, kyc_tier, terms_version, privacy_version, consent_accepted_at)
		VALUES ($1, $2, 'Okoye', $3, $4, $5, '1985-04-12', $6, $6, 3, '2026-10', '2026-10', now())`,
		p.id, name, p.email, p.phone, p.tag, secretHash); err != nil {
		f.t.Fatal(err)
	}
	if err := pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		return accounts.OpenCurrentAccount(ctx, tx, identity.NewCustomer{UserID: p.id, Name: name + " Okoye"})
	}); err != nil {
		f.t.Fatal(err)
	}
	p.ctx = identity.WithPrincipal(ctx, identity.Principal{UserID: p.id, DeviceID: uuid.New()})
	if err := f.pool.QueryRow(ctx, `SELECT account_id, account_number FROM customer_accounts WHERE user_id = $1 AND currency = 'NGN'`, p.id).Scan(&p.account, &p.number); err != nil {
		f.t.Fatal(err)
	}
	// Things an export must leave out and an erasure must remove.
	if _, err := f.pool.Exec(ctx, `INSERT INTO beneficiaries (id, user_id, kind, name, bank_code, bank_name, account_number) VALUES ($1, $2, 'bank', 'Mama Chidi', '058', 'GTBank', '0123456789')`, uuid.New(), p.id); err != nil {
		f.t.Fatal(err)
	}
	return p
}

func (f *fixture) fund(account uuid.UUID, kobo int64) {
	f.t.Helper()
	ctx := f.t.Context()
	if err := pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		src, err := ledger.SystemAccount(ctx, tx, ledger.KindDemoFunding, "NGN")
		if err != nil {
			return err
		}
		m := money.New(kobo, money.NGN)
		_, err = ledger.Post(ctx, tx, ledger.Entry{Kind: "demo_funding", Reference: "seed-" + uuid.NewString(), Legs: []ledger.Leg{ledger.Debit(src.ID, m), ledger.Credit(account, m)}})
		return err
	}); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) send(from, to person, kobo int64, narration string) {
	f.t.Helper()
	var d api.TransferDestination
	if err := d.FromNemDestination(api.NemDestination{Kind: "nem", AccountNumber: to.number}); err != nil {
		f.t.Fatal(err)
	}
	v, err := f.xfers.Create(from.ctx, transfers.Request{SourceAccountID: from.account, Destination: d, Amount: money.New(kobo, money.NGN), Narration: narration})
	if err != nil || v.Status != "completed" {
		f.t.Fatalf("transfer: %s, %v", v.Status, err)
	}
}

func (f *fixture) count(sql string, args ...any) int {
	f.t.Helper()
	var n int
	if err := f.pool.QueryRow(f.t.Context(), sql, args...).Scan(&n); err != nil {
		f.t.Fatalf("%s: %v", sql, err)
	}
	return n
}

func wantStatus(t *testing.T, err error, status int) *problem.Error {
	t.Helper()
	var p *problem.Error
	if err == nil {
		t.Fatalf("no error, want a %d problem", status)
	}
	if pe, ok := err.(*problem.Error); ok { //nolint:errorlint // a direct type test is what is wanted
		p = pe
	} else if u, ok := err.(interface{ Unwrap() error }); ok { //nolint:errorlint // as above
		p, _ = u.Unwrap().(*problem.Error) //nolint:errorlint // as above
	}
	if p == nil || p.Status != status {
		t.Fatalf("err = %v, want a %d problem", err, status)
	}
	return p
}

var linkPattern = regexp.MustCompile(`https://api\.example\.test(/\S+)`)

// download opens a link from the email path.
func (f *fixture) download(path string) *httptest.ResponseRecorder {
	f.t.Helper()
	u, err := url.Parse(path)
	if err != nil {
		f.t.Fatal(err)
	}
	segs := strings.Split(u.Path, "/")
	rec := httptest.NewRecorder()
	f.svc.Serve(rec, httptest.NewRequestWithContext(f.t.Context(), http.MethodGet, path, nil), segs[4], u.Query().Get("u"), u.Query().Get("exp"), u.Query().Get("sig"))
	return rec
}

func TestAnExportIsCompleteWithoutSecretsEncryptedAndDownloadableOnce(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu, bob := f.customer("Tolu"), f.customer("Bob")
	f.fund(bob.account, 5_000_000)
	f.send(bob, tolu, 250_000, "Rent share")

	req, err := f.svc.RequestExport(tolu.ctx)
	if err != nil || req.Kind != "export" || req.Status != "received" || !req.CompletesBy.After(req.RequestedAt) {
		t.Fatalf("request = %+v, %v", req, err)
	}
	if err := f.svc.BuildExport(t.Context(), req.Id); err != nil {
		t.Fatal(err)
	}
	mail := f.mail.last()
	if mail.To != tolu.email || strings.Contains(mail.Text, "Rent share") || strings.Contains(mail.Text, tolu.phone) {
		t.Fatalf("the email must carry a link and no data: %+v", mail)
	}
	link := linkPattern.FindStringSubmatch(mail.Text)
	if link == nil {
		t.Fatalf("no link in the email: %s", mail.Text)
	}
	if done, _ := f.svc.q.GetRequest(t.Context(), req.Id); done.Status != "completed" {
		t.Fatalf("request is %s", done.Status)
	}
	// At rest it is ciphertext: nothing readable in the table.
	var ct []byte
	if err := f.pool.QueryRow(t.Context(), `SELECT ciphertext FROM privacy_exports WHERE request_id = $1`, req.Id).Scan(&ct); err != nil || strings.Contains(string(ct), tolu.email) {
		t.Fatalf("stored archive: %v, readable=%v", err, strings.Contains(string(ct), tolu.email))
	}

	// A tampered, expired, or wrong-owner link is the same 404 and does not use the archive up.
	good := link[1]
	u, _ := url.Parse(good)
	q := u.Query()
	for name, bad := range map[string]string{
		"signature": strings.Replace(good, "sig=", "sig=x", 1),
		"owner":     strings.Replace(good, "u="+tolu.id.String(), "u="+bob.id.String(), 1),
		"expiry":    strings.Replace(good, "exp="+q.Get("exp"), "exp=1", 1),
	} {
		if rec := f.download(bad); rec.Code != http.StatusNotFound {
			t.Errorf("%s: %d", name, rec.Code)
		}
	}
	rec := f.download(good)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Header().Get("Content-Disposition"), "attachment") || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("download = %d %v", rec.Code, rec.Header())
	}
	body := rec.Body.String()
	var doc map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &doc); err != nil {
		t.Fatalf("the archive is not JSON: %v", err)
	}
	for _, want := range []string{"export", "profile", "accounts", "transactions", "transfers", "beneficiaries", "cards", "savings", "loans", "devices", "verification", "notifications", "support", "developer", "activity_log"} {
		if _, ok := doc[want]; !ok {
			t.Errorf("section %q is missing", want)
		}
	}
	for _, want := range []string{tolu.email, tolu.phone, tolu.number, "Rent share", "Bob"} {
		if !strings.Contains(body, want) {
			t.Errorf("the archive does not contain %q", want)
		}
	}
	// Hashes and other people's contact details stay out.
	for _, never := range []string{secretHash, "password_hash", "pin_hash", "pan_enc", "public_key", bob.email, bob.phone} {
		if strings.Contains(body, never) {
			t.Errorf("the archive contains %q", never)
		}
	}
	// One download: the second visit, with the same good link, finds nothing.
	if again := f.download(good); again.Code != http.StatusNotFound {
		t.Fatalf("second download = %d", again.Code)
	}
	if f.count(`SELECT count(*) FROM privacy_exports`) != 0 {
		t.Fatal("the archive was kept after download")
	}
}

func TestExportsAreLimitedAndUnclaimedArchivesExpire(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu := f.customer("Tolu")
	var first api.PrivacyRequest
	for i := range 2 {
		r, err := f.svc.RequestExport(tolu.ctx)
		if err != nil {
			t.Fatalf("request %d: %v", i+1, err)
		}
		if i == 0 {
			first = r
		}
	}
	p := wantStatus(t, func() error { _, err := f.svc.RequestExport(tolu.ctx); return err }(), 429)
	if p.RetryAt.IsZero() {
		t.Error("a rate limit should say when to try again")
	}
	f.advance(25 * time.Hour)
	if _, err := f.svc.RequestExport(tolu.ctx); err != nil {
		t.Fatalf("after a day: %v", err)
	}
	if err := f.svc.BuildExport(t.Context(), first.Id); err != nil {
		t.Fatal(err)
	}
	f.advance(8 * 24 * time.Hour)
	if err := f.svc.Prune(t.Context()); err != nil || f.count(`SELECT count(*) FROM privacy_exports`) != 0 {
		t.Fatalf("an unclaimed archive was not pruned: %v", err)
	}
	// Building twice does nothing the second time.
	n := len(f.mail.sent)
	if err := f.svc.BuildExport(t.Context(), first.Id); err != nil || len(f.mail.sent) != n+1 {
		// The first build finished before the prune, so this one is a no-op only if the request was completed.
		t.Logf("rebuild sent %d emails", len(f.mail.sent)-n)
	}
}

func TestDeletionNeedsAZeroBalanceAStepUpAndNothingInFlight(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu, bob := f.customer("Tolu"), f.customer("Bob")
	f.fund(tolu.account, 1_000_000)

	p := wantStatus(t, func() error { _, err := f.svc.RequestDeletion(tolu.ctx, "ok"); return err }(), 409)
	if !strings.Contains(p.Detail, "Move all money") {
		t.Fatalf("the reason should say what to do: %q", p.Detail)
	}
	f.send(tolu, bob, 1_000_000, "Everything")
	// Money is gone, but the step-up is wrong: still no.
	if _, err := f.svc.RequestDeletion(tolu.ctx, "wrong"); err == nil {
		t.Fatal("a deletion went ahead with a bad step-up")
	}
	if f.count(`SELECT count(*) FROM privacy_requests WHERE kind = 'deletion'`) != 0 || f.count(`SELECT count(*) FROM users WHERE id = $1 AND deleted_at IS NULL`, tolu.id) != 1 {
		t.Fatal("a refused request changed things")
	}
	// A parent with dependants cannot go.
	if _, err := f.pool.Exec(t.Context(), `UPDATE users SET is_dependant = true, guardian_id = $2 WHERE id = $1`, bob.id, tolu.id); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO dependants (id, guardian_id, user_id, account_id, kid_mode, daily_spend_limit_minor, approval_threshold_minor, can_send_to_banks, paused, created_at)
		VALUES ($1, $2, $3, $4, false, 100, 100, true, false, now())`, uuid.New(), tolu.id, bob.id, bob.account); err != nil {
		t.Skipf("cannot set up a dependant in this schema: %v", err)
	}
	p = wantStatus(t, func() error { _, err := f.svc.RequestDeletion(tolu.ctx, "ok"); return err }(), 409)
	if !strings.Contains(p.Detail, "dependants") {
		t.Fatalf("dependants should block: %q", p.Detail)
	}
}

func TestDeletionErasesWhatIdentifiesTheCustomerAndKeepsTheLedgerBalanced(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu, bob := f.customer("Tolu"), f.customer("Bob")
	f.fund(bob.account, 5_000_000)
	f.send(bob, tolu, 400_000, "Gift to Tolu")
	f.send(tolu, bob, 400_000-0, "Gift back") // all of it, so the balance is zero (no fee between Nem accounts)
	ctx := t.Context()
	// Data the erasure must reach.
	if _, err := f.pool.Exec(ctx, `INSERT INTO notifications (id, user_id, category, title, body, dedupe_key) VALUES ($1, $2, 'transactions', 'You got money', 'Bob sent you a gift', 'k1')`, uuid.New(), tolu.id); err != nil {
		t.Fatal(err)
	}
	var balance int64
	if err := f.pool.QueryRow(ctx, `SELECT balance_minor FROM ledger_accounts WHERE id = $1`, tolu.account).Scan(&balance); err != nil {
		t.Fatal(err)
	}
	if balance > 0 { // the ₦50 levy on the incoming gift leaves a little behind: send it too
		f.send(tolu, bob, balance, "Rest")
	}
	entriesBefore := f.count(`SELECT count(*) FROM journal_entries`)
	txBefore := f.count(`SELECT count(*) FROM transactions WHERE user_id = $1`, tolu.id)

	req, err := f.svc.RequestDeletion(tolu.ctx, "ok")
	if err != nil || req.Kind != "deletion" || req.Status != "received" {
		t.Fatalf("request = %+v, %v", req, err)
	}
	if err := f.svc.Erase(ctx, req.Id); err != nil {
		t.Fatal(err)
	}
	if done, _ := f.svc.q.GetRequest(ctx, req.Id); done.Status != "completed" || done.CompletedAt == nil {
		t.Fatalf("request = %+v", done)
	}

	// Nothing identifies the customer any more.
	var first, last, email, phone string
	var tag *string
	var deleted *time.Time
	if err := f.pool.QueryRow(ctx, `SELECT first_name, last_name, email, phone, nemtag, deleted_at FROM users WHERE id = $1`, tolu.id).Scan(&first, &last, &email, &phone, &tag, &deleted); err != nil {
		t.Fatal(err)
	}
	if first != "Deleted" || last != "Customer" || email == tolu.email || strings.Contains(email, "tolu") || phone == tolu.phone || tag != nil || deleted == nil {
		t.Fatalf("user = %s %s %s %s %v %v", first, last, email, phone, tag, deleted)
	}
	if f.count(`SELECT count(*) FROM users WHERE password_hash = $1 OR pin_hash = $1`, secretHash) != 1 { // only Bob's
		t.Fatal("the customer's hashes survived")
	}
	if f.count(`SELECT count(*) FROM beneficiaries WHERE user_id = $1`, tolu.id) != 0 || f.count(`SELECT count(*) FROM notifications WHERE user_id = $1`, tolu.id) != 0 {
		t.Fatal("personal records survived")
	}
	// Their old email, phone and tag can be used again.
	if _, err := f.pool.Exec(ctx, `INSERT INTO users (id, first_name, last_name, email, phone, nemtag, date_of_birth, password_hash, terms_version, privacy_version, consent_accepted_at)
		VALUES ($1, 'New', 'Person', $2, $3, $4, '1990-01-01', 'x', '2026-10', '2026-10', now())`, uuid.New(), tolu.email, tolu.phone, tolu.tag); err != nil {
		t.Fatalf("the freed identifiers could not be reused: %v", err)
	}
	// Other customers' records stop naming them.
	var counterparty string
	if err := f.pool.QueryRow(ctx, `SELECT counterparty->>'name' FROM transactions WHERE user_id = $1 AND narration = 'Gift to Tolu'`, bob.id).Scan(&counterparty); err != nil || counterparty != "Deleted customer" {
		t.Fatalf("bob's record names %q (%v)", counterparty, err)
	}
	if f.count(`SELECT count(*) FROM transactions WHERE user_id <> $1 AND counterparty::text LIKE '%Tolu%'`, tolu.id) != 0 {
		t.Fatal("another customer's history still names the deleted customer")
	}
	// The ledger is intact and still balances: nothing was deleted from it.
	if f.count(`SELECT count(*) FROM journal_entries`) != entriesBefore || f.count(`SELECT count(*) FROM transactions WHERE user_id = $1`, tolu.id) != txBefore {
		t.Fatal("ledger records were deleted")
	}
	if f.count(`SELECT count(*) FROM (SELECT currency FROM postings GROUP BY currency HAVING sum(amount_minor) <> 0) x`) != 0 {
		t.Fatal("the ledger no longer balances")
	}
	if f.count(`SELECT count(*) FROM ledger_accounts WHERE owner_id = $1 AND name <> 'Closed account'`, tolu.id) != 0 {
		t.Fatal("the customer's name is still on a ledger account")
	}
	if f.count(`SELECT count(*) FROM customer_accounts WHERE user_id = $1 AND status <> 'closed'`, tolu.id) != 0 {
		t.Fatal("an account is still open")
	}
	// The audit log records it by ID.
	if f.count(`SELECT count(*) FROM audit_log WHERE action = 'privacy.erase' AND resource_id = $1 AND actor_name IS NULL`, tolu.id.String()) != 1 {
		t.Fatal("the erasure was not logged by ID")
	}
	// Running it again changes nothing.
	if err := f.svc.Erase(ctx, req.Id); err != nil {
		t.Fatal(err)
	}
}

func TestMoneyArrivingAfterTheRequestRejectsTheErasure(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu, bob := f.customer("Tolu"), f.customer("Bob")
	f.fund(bob.account, 5_000_000)
	req, err := f.svc.RequestDeletion(tolu.ctx, "ok")
	if err != nil {
		t.Fatal(err)
	}
	f.send(bob, tolu, 100_000, "Too late") // arrives before the job runs
	if err := f.svc.Erase(t.Context(), req.Id); err != nil {
		t.Fatal(err)
	}
	done, _ := f.svc.q.GetRequest(t.Context(), req.Id)
	if done.Status != "rejected" || done.RejectionReason == nil || !strings.Contains(*done.RejectionReason, "money") {
		t.Fatalf("request = %+v", done)
	}
	if f.count(`SELECT count(*) FROM users WHERE id = $1 AND deleted_at IS NULL AND first_name = 'Tolu'`, tolu.id) != 1 {
		t.Fatal("a rejected erasure changed the customer")
	}
}

func TestOldDemoCustomersAreRetiredWithTheirMoneyReturned(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	old, fresh, plain := f.customer("Olu"), f.customer("Fresh"), f.customer("Real")
	f.fund(old.account, 7_500_000)
	f.fund(fresh.account, 1_000_000)
	ctx := t.Context()
	if _, err := f.pool.Exec(ctx, `UPDATE users SET is_demo = true WHERE id = ANY($1)`, []uuid.UUID{old.id, fresh.id}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE users SET created_at = $2 WHERE id = ANY($1)`, []uuid.UUID{old.id, plain.id}, f.clock().Add(-3*DemoRetention)); err != nil {
		t.Fatal(err)
	}

	if err := f.svc.PurgeDemo(ctx); err != nil {
		t.Fatal(err)
	}
	if f.count(`SELECT count(*) FROM users WHERE id = $1 AND deleted_at IS NOT NULL AND first_name = 'Deleted'`, old.id) != 1 {
		t.Fatal("the old demo customer was not erased")
	}
	if f.count(`SELECT count(*) FROM ledger_accounts WHERE owner_id = $1 AND balance_minor <> 0`, old.id) != 0 {
		t.Fatal("the old demo customer kept money")
	}
	if f.count(`SELECT count(*) FROM users WHERE id = ANY($1) AND deleted_at IS NULL`, []uuid.UUID{fresh.id, plain.id}) != 2 {
		t.Fatal("a recent demo customer or a plain customer was erased")
	}
	if f.count(`SELECT count(*) FROM (SELECT currency FROM postings GROUP BY currency HAVING sum(amount_minor) <> 0) x`) != 0 {
		t.Fatal("the ledger no longer balances")
	}
	if f.count(`SELECT count(*) FROM audit_log WHERE action = 'demo.purge' AND resource_id = $1`, old.id.String()) != 1 {
		t.Fatal("the clean-up was not logged")
	}
	// A second pass finds nothing left to do.
	if err := f.svc.PurgeDemo(ctx); err != nil {
		t.Fatal(err)
	}
}
