package console

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/admin"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/fx"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/kyc"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/limits"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/fieldcrypt"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/mailer"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/risk"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/support"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers"
)

// dbCustomers reads profiles from the users table and has no device cool-off, so the money
// services run without a signed-in session behind each customer.
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

const staffPassword = "Lagoon-Harmattan-Kettle-42" // gitleaks:allow (test fixture, not a credential)

type fixture struct {
	t      *testing.T
	pool   *pgxpool.Pool
	svc    *Service
	admin  *admin.Service
	limits *limits.Service
	xfers  *transfers.Service
	disp   *support.Service
	n      int
	mu     sync.Mutex
	now    time.Time
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
	f := &fixture{t: t, pool: pool, now: time.Now().UTC().Truncate(time.Millisecond)}
	keyring, err := fieldcrypt.New(map[uint16][]byte{1: []byte("0123456789abcdef0123456789abcdef")}, []byte("fedcba9876543210fedcba9876543210"))
	if err != nil {
		t.Fatal(err)
	}
	hasher := identity.NewHasher(identity.Argon2Params{MemoryKiB: 64, Time: 1, Threads: 1}, 2)
	f.admin, err = admin.NewService(admin.Config{
		Pool: pool, Logger: quiet, SigningKey: []byte("staff-signing-seed-0123456789abc"), Keyring: keyring, Hasher: hasher, Now: f.clock,
	})
	if err != nil {
		t.Fatal(err)
	}
	idSvc, err := identity.NewService(identity.Config{
		Pool: pool, Mailer: mailer.Log{Logger: quiet}, Logger: quiet, OTPKey: []byte("otp-key-0123456789abcdef01234567"),
		SigningKey: []byte("jwt-signing-seed-0123456789abcde"), Hasher: hasher, Now: f.clock,
	})
	if err != nil {
		t.Fatal(err)
	}
	cust := dbCustomers{pool}
	accts, err := accounts.NewService(accounts.Config{
		Pool: pool, Customers: cust, Logger: quiet, Now: f.clock,
		Timelines: func(ctx context.Context, id uuid.UUID) ([]api.TimelineEvent, error) { return f.xfers.Timeline(ctx, id) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if f.limits, err = limits.NewService(limits.Config{Pool: pool, Customers: cust, StepUps: idSvc, Now: f.clock}); err != nil {
		t.Fatal(err)
	}
	rs, err := risk.NewService(risk.Config{Engine: risk.RulesOnly(), Logger: quiet})
	if err != nil {
		t.Fatal(err)
	}
	if f.xfers, err = transfers.NewService(transfers.Config{
		Pool: pool, Accounts: accts, Customers: cust, Limits: f.limits, StepUps: idSvc, Risk: rs, Logger: quiet, Now: f.clock,
	}); err != nil {
		t.Fatal(err)
	}
	fxSvc, err := fx.NewService(fx.Config{Pool: pool, Accounts: accts, Customers: cust, Limits: f.limits, Logger: quiet, Now: f.clock})
	if err != nil {
		t.Fatal(err)
	}
	kycSvc, err := kyc.NewService(kyc.Config{
		Pool: pool, Identifiers: kyc.NewIdentifiers(keyring), Keyring: keyring, Limits: f.limits, Logger: quiet, Now: f.clock,
	})
	if err != nil {
		t.Fatal(err)
	}
	supportSvc, err := support.NewService(support.Config{Pool: pool, FilesKey: make([]byte, 32), Logger: quiet, Now: f.clock})
	if err != nil {
		t.Fatal(err)
	}
	f.disp = supportSvc
	f.svc, err = NewService(Config{
		RefundApprovalMinor: naira(1_000),
		Pool:                pool, Admin: f.admin, KYC: kycSvc, Support: supportSvc, Transfers: f.xfers, Accounts: accts, Identity: idSvc,
		FX: fxSvc, Limits: f.limits, LinkKey: []byte("review-link-key-0123456789abcdef"), Logger: quiet, Now: f.clock,
	})
	if err != nil {
		t.Fatal(err)
	}
	return f
}

// member is a staff member acting with the given roles.
func (f *fixture) member(name string, roles ...admin.Role) context.Context {
	f.t.Helper()
	f.n++
	st, err := f.admin.CreateStaff(f.t.Context(), admin.StaffInput{Name: name, Email: fmt.Sprintf("staff%d@nem.bank", f.n), Password: staffPassword, Roles: roles})
	if err != nil {
		f.t.Fatalf("create staff: %v", err)
	}
	return admin.WithPrincipal(f.t.Context(), admin.Principal{StaffID: st.ID, SessionID: uuid.New(), Name: name, Roles: roles})
}

type person struct {
	ctx     context.Context
	id      uuid.UUID
	account uuid.UUID
	number  string
	tag     string
}

func (f *fixture) customer(name, tag string, balance int64) person {
	f.t.Helper()
	ctx := f.t.Context()
	id := uuid.New()
	f.n++
	if _, err := f.pool.Exec(ctx, `INSERT INTO users (id, first_name, last_name, email, phone, nemtag, date_of_birth,
		password_hash, kyc_tier, terms_version, privacy_version, consent_accepted_at)
		VALUES ($1, $2, 'Test', $3, $4, $5, '1985-04-12', 'x', 2, '2026-10', '2026-10', now())`,
		id, name, fmt.Sprintf("c%d@example.com", f.n), fmt.Sprintf("+2348033%06d", f.n), tag); err != nil {
		f.t.Fatal(err)
	}
	if err := pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		return accounts.OpenCurrentAccount(ctx, tx, identity.NewCustomer{UserID: id, Name: name + " Test"})
	}); err != nil {
		f.t.Fatal(err)
	}
	p := person{id: id, tag: tag, ctx: identity.WithPrincipal(ctx, identity.Principal{UserID: id, DeviceID: uuid.New()})}
	if err := f.pool.QueryRow(ctx, `SELECT account_id, account_number FROM customer_accounts WHERE user_id = $1 AND currency = 'NGN'`, id).Scan(&p.account, &p.number); err != nil {
		f.t.Fatal(err)
	}
	if balance > 0 {
		f.post("demo_funding", ledger.KindDemoFunding, p.account, balance)
	}
	return p
}

// post moves kobo from a system account to a customer account.
func (f *fixture) post(kind string, from string, to uuid.UUID, kobo int64) {
	f.t.Helper()
	ctx := f.t.Context()
	if err := pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		src, err := ledger.SystemAccount(ctx, tx, from, "NGN")
		if err != nil {
			return err
		}
		m := money.New(kobo, money.NGN)
		_, err = ledger.Post(ctx, tx, ledger.Entry{Kind: kind, Reference: "seed-" + uuid.NewString(), Legs: []ledger.Leg{ledger.Debit(src.ID, m), ledger.Credit(to, m)}})
		return err
	}); err != nil {
		f.t.Fatal(err)
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

func wantProblem(t *testing.T, err error, want *problem.Error) {
	t.Helper()
	if !errors.Is(err, want) {
		t.Fatalf("err = %v, want %s (%d)", err, want.Code, want.Status)
	}
}

func wantStatus(t *testing.T, err error, status int) {
	t.Helper()
	var p *problem.Error
	if !errors.As(err, &p) || p.Status != status {
		t.Fatalf("err = %v, want a %d problem", err, status)
	}
}

func naira(n int64) int64 { return n * 100 }

func toNem(number string) api.TransferDestination {
	var d api.TransferDestination
	if err := d.FromNemDestination(api.NemDestination{Kind: "nem", AccountNumber: number}); err != nil {
		panic(err)
	}
	return d
}

func TestFreezingBlocksOutgoingMoneyAndUnfreezingNeedsASecondMember(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	maker := f.member("Aisha Bello", admin.RoleCompliance)
	checker := f.member("Ifeoma Adeyemi", admin.RoleAdmin)
	support := f.member("Chidi Eze", admin.RoleSupport)
	tolu, ada := f.customer("Tolu", "tolu", naira(100_000)), f.customer("Ada", "ada", 0)

	c, err := f.svc.Freeze(maker, tolu.id, "Reported stolen phone")
	if err != nil {
		t.Fatal(err)
	}
	if c.Customer.Status != "frozen" || len(c.Flags) == 0 || !c.Panic.OutgoingBlocked || c.Accounts[0].Status != "frozen" {
		t.Fatalf("after freeze: %+v", c)
	}
	// Outgoing money is refused; the account is frozen.
	if _, err := f.xfers.Create(tolu.ctx, transfers.Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: money.New(naira(1_000), money.NGN), Narration: "Rent"}); err == nil {
		t.Fatal("a frozen customer sent money")
	}
	// Freezing twice is a conflict; a customer that does not exist is a 404.
	_, err = f.svc.Freeze(maker, tolu.id, "Again for good measure")
	wantProblem(t, err, errAlreadyFrozen)
	_, err = f.svc.Freeze(maker, uuid.New(), "No such person")
	wantProblem(t, err, errNoCustomer)

	// Unfreezing is a request; nothing changes until someone else approves it.
	ap, err := f.svc.RequestUnfreeze(maker, tolu.id, "Verified on a video call")
	if err != nil || ap.Status != "pending" {
		t.Fatalf("request: %+v, %v", ap, err)
	}
	if got, _ := f.svc.customerSummary(t.Context(), tolu.id); got.Status != "frozen" {
		t.Fatal("the request alone unfroze the customer")
	}
	_, err = f.admin.Approve(maker, ap.Id)
	wantProblem(t, err, admin.ErrSameStaff)
	if _, err := f.admin.Approve(support, ap.Id); err == nil {
		t.Fatal("a support agent approved an unfreeze")
	}
	if _, err := f.admin.Approve(checker, ap.Id); err != nil {
		t.Fatal(err)
	}
	if got, _ := f.svc.customerSummary(t.Context(), tolu.id); got.Status != "active" {
		t.Fatalf("after approval: %s", got.Status)
	}
	if _, err := f.xfers.Create(tolu.ctx, transfers.Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: money.New(naira(1_000), money.NGN), Narration: "Rent"}); err != nil {
		t.Fatalf("after unfreeze: %v", err)
	}
	// An unfreeze for someone who is not frozen cannot even be asked for.
	_, err = f.svc.RequestUnfreeze(maker, tolu.id, "Just in case")
	wantProblem(t, err, errNotFrozen)

	for _, a := range []string{"customer.freeze", "customer.unfreeze", "approval.request", "approval.approve"} {
		if f.count(`SELECT count(*) FROM audit_log WHERE action = $1`, a) == 0 {
			t.Errorf("no audit entry for %s", a)
		}
	}
}

func TestSupportSeesAMaskedCustomerWithoutADateOfBirth(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	agent := f.member("Chidi Eze", admin.RoleSupport)
	compliance := f.member("Aisha Bello", admin.RoleCompliance)
	tolu := f.customer("Tolu", "tolu", naira(5_000))

	c, err := f.svc.Customer360(agent, tolu.id)
	if err != nil {
		t.Fatal(err)
	}
	if c.DateOfBirth != nil || strings.Contains(c.Customer.EmailMasked, "example") == false || strings.Contains(c.Customer.EmailMasked, "c1@") || !strings.HasPrefix(c.Customer.PhoneMasked, "+234") || !strings.Contains(c.Customer.PhoneMasked, "***") {
		t.Fatalf("support view: dob=%v email=%q phone=%q", c.DateOfBirth, c.Customer.EmailMasked, c.Customer.PhoneMasked)
	}
	if len(c.Accounts) != 1 || c.Accounts[0].AvailableBalance.AmountMinor != fmt.Sprint(naira(5_000)) {
		t.Fatalf("accounts: %+v", c.Accounts)
	}
	full, err := f.svc.Customer360(compliance, tolu.id)
	if err != nil || full.DateOfBirth == nil {
		t.Fatalf("compliance view: %v, %v", full.DateOfBirth, err)
	}

	if _, err := f.svc.AddNote(agent, tolu.id, "  Called about a card; call back Monday.  "); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.AddNote(agent, tolu.id, "   "); err == nil {
		t.Fatal("an empty note was accepted")
	}
	again, _ := f.svc.Customer360(compliance, tolu.id)
	if len(again.Notes) != 1 || again.Notes[0].Author.Name != "Chidi Eze" || again.Notes[0].Body != "Called about a card; call back Monday." {
		t.Fatalf("notes: %+v", again.Notes)
	}
	// A note's text is never copied into the audit log.
	if n := f.count(`SELECT count(*) FROM audit_log WHERE metadata::text LIKE '%call back%'`); n != 0 {
		t.Fatal("a note's text reached the audit log")
	}
	_, err = f.svc.Customer360(agent, uuid.New())
	wantProblem(t, err, errNoCustomer)
}

func TestSearchFindsCustomersByTagPhoneAndAccountAndIsAudited(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	agent := f.member("Chidi Eze", admin.RoleSupport)
	tolu, _ := f.customer("Tolu", "tolu", 0), f.customer("Ada", "ada", 0)

	for _, q := range []string{"tolu", "@tolu", "Tolu Test", tolu.number, "+2348033000001"[:11]} {
		rows, _, err := f.svc.SearchCustomers(agent, q, nil, nil)
		if err != nil {
			t.Fatalf("%q: %v", q, err)
		}
		found := false
		for _, r := range rows {
			found = found || r.UserId == tolu.id
		}
		if !found {
			t.Errorf("search %q did not find Tolu (%d rows)", q, len(rows))
		}
	}
	if _, _, err := f.svc.SearchCustomers(agent, "t", nil, nil); err == nil {
		t.Fatal("a one-letter search was accepted")
	}
	// What was searched for is not logged; that it happened is.
	if f.count(`SELECT count(*) FROM audit_log WHERE action = 'customer.search'`) < 5 || f.count(`SELECT count(*) FROM audit_log WHERE metadata::text LIKE '%tolu%'`) != 0 {
		t.Fatal("search audit is wrong")
	}
	// A percent sign is just a character, not a wildcard.
	if rows, _, _ := f.svc.SearchCustomers(agent, "%%", nil, nil); len(rows) != 0 {
		t.Fatalf("wildcard matched %d customers", len(rows))
	}
}

func TestAnApprovedLimitOverrideRaisesTheDailyLimitUntilItExpires(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	maker := f.member("Aisha Bello", admin.RoleCompliance)
	checker := f.member("Ifeoma Adeyemi", admin.RoleAdmin)
	tolu := f.customer("Tolu", "tolu", 0)
	daily := func() int64 {
		st, err := f.limits.StatusFor(t.Context(), f.pool, tolu.id, 2, identity.CoolOff{})
		if err != nil {
			t.Fatal(err)
		}
		return st.DailyMinor
	}
	base := daily()

	req := api.LimitOverrideRequest{
		DailyLimit: api.Money{AmountMinor: fmt.Sprint(naira(1_000_000)), Currency: "NGN"}, ExpiresAt: f.clock().Add(48 * time.Hour), Reason: "Property completion, verified with the bank",
	}
	ap, err := f.svc.RequestLimitOverride(maker, tolu.id, req)
	if err != nil {
		t.Fatal(err)
	}
	if daily() != base {
		t.Fatal("the request alone raised the limit")
	}
	if _, err := f.admin.Approve(checker, ap.Id); err != nil {
		t.Fatal(err)
	}
	if got := daily(); got != naira(1_000_000) {
		t.Fatalf("daily limit = %d, want ₦1,000,000", got)
	}
	f.advance(72 * time.Hour)
	if got := daily(); got != base {
		t.Fatalf("after expiry = %d, want %d", got, base)
	}

	bad := req
	bad.ExpiresAt = f.clock().Add(90 * 24 * time.Hour)
	_, err = f.svc.RequestLimitOverride(maker, tolu.id, bad)
	wantStatus(t, err, 400)
	bad = req
	bad.DailyLimit.Currency = "USD"
	_, err = f.svc.RequestLimitOverride(maker, tolu.id, bad)
	wantStatus(t, err, 400)
}

func TestAConfigChangeNeedsApprovalAppliesLiveAndRefusesStaleOrSillyValues(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	maker := f.member("Tunde Okafor", admin.RoleFinance)
	checker := f.member("Ifeoma Adeyemi", admin.RoleAdmin)

	cfg, err := f.svc.BankConfig(maker)
	if err != nil || cfg.Version != 1 || len(cfg.Limits) != 3 || cfg.FxSpreadsBps["USD-NGN"] != fx.DefaultSpreadBPS {
		t.Fatalf("default config = %+v, %v", cfg, err)
	}
	change := func(section string, value string, base int) api.ConfigChangeRequest {
		return api.ConfigChangeRequest{Section: api.ConfigChangeRequestSection(section), Value: []byte(value), Reason: "Quarterly pricing review", BaseVersion: base}
	}

	ap, err := f.svc.RequestConfigChange(maker, change("cooling_off", `{"new_beneficiary_threshold":{"amount_minor":"5000000","currency":"NGN"},"delay_minutes":45}`, 1))
	if err != nil {
		t.Fatal(err)
	}
	if got := f.limits.Rules().CoolingOffDelay; got != 30*time.Minute {
		t.Fatalf("the request alone changed the delay to %s", got)
	}
	if _, err := f.admin.Approve(checker, ap.Id); err != nil {
		t.Fatal(err)
	}
	r := f.limits.Rules()
	if r.CoolingOffDelay != 45*time.Minute || r.CoolingOffThresholdMinor != 5_000_000 {
		t.Fatalf("live rules after approval: %+v", r)
	}
	cfg, _ = f.svc.BankConfig(maker)
	if cfg.Version != 2 || cfg.CoolingOff.DelayMinutes != 45 {
		t.Fatalf("stored config = %+v", cfg)
	}

	// FX spreads reach the FX service.
	ap, err = f.svc.RequestConfigChange(maker, change("fx_spreads_bps", `{"USD-NGN":200}`, 2))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.admin.Approve(checker, ap.Id); err != nil {
		t.Fatal(err)
	}

	// A change made against an old version is stale, at request time and at approval time.
	_, err = f.svc.RequestConfigChange(maker, change("cooling_off", `{"new_beneficiary_threshold":{"amount_minor":"1","currency":"NGN"},"delay_minutes":5}`, 1))
	wantProblem(t, err, errStaleConfig)
	first, err := f.svc.RequestConfigChange(maker, change("cooling_off", `{"new_beneficiary_threshold":{"amount_minor":"100","currency":"NGN"},"delay_minutes":10}`, 3))
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.svc.RequestConfigChange(maker, change("cooling_off", `{"new_beneficiary_threshold":{"amount_minor":"200","currency":"NGN"},"delay_minutes":20}`, 3))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.admin.Approve(checker, first.Id); err != nil {
		t.Fatal(err)
	}
	_, err = f.admin.Approve(checker, second.Id)
	wantProblem(t, err, errStaleConfig)

	// Values that make no sense never become a pending request.
	for name, c := range map[string]api.ConfigChangeRequest{
		"descending limits":   change("limits", `[{"tier":1,"daily_limit":{"amount_minor":"9000000","currency":"NGN"},"max_balance":null},{"tier":2,"daily_limit":{"amount_minor":"100","currency":"NGN"},"max_balance":null},{"tier":3,"daily_limit":{"amount_minor":"200","currency":"NGN"},"max_balance":null}]`, 4),
		"open band in middle": change("fees", `{"internal_transfer":{"amount_minor":"0","currency":"NGN"},"emtl":{"amount_minor":"5000","currency":"NGN"},"emtl_threshold":{"amount_minor":"1000000","currency":"NGN"},"external_transfer_bands":[{"up_to":null,"fee":{"amount_minor":"1000","currency":"NGN"}},{"up_to":null,"fee":{"amount_minor":"2000","currency":"NGN"}}]}`, 4),
		"a paid internal fee": change("fees", `{"internal_transfer":{"amount_minor":"100","currency":"NGN"},"emtl":{"amount_minor":"5000","currency":"NGN"},"emtl_threshold":{"amount_minor":"1000000","currency":"NGN"},"external_transfer_bands":[{"up_to":null,"fee":{"amount_minor":"1000","currency":"NGN"}}]}`, 4),
		"spread too wide":     change("fx_spreads_bps", `{"USD-NGN":9000}`, 4),
		"unknown pair":        change("fx_spreads_bps", `{"JPY-NGN":100}`, 4),
		"unknown field":       change("cooling_off", `{"delay_minutes":10,"surprise":true,"new_beneficiary_threshold":{"amount_minor":"1","currency":"NGN"}}`, 4),
		"unknown section":     change("nonsense", `{}`, 4),
	} {
		if _, err := f.svc.RequestConfigChange(maker, c); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if n := f.count(`SELECT count(*) FROM approval_requests WHERE action = 'config_change'`); n != 4 {
		t.Fatalf("config approvals = %d, want 4 (the silly ones must not be recorded)", n)
	}
}

func TestAPaidFeatureFlagCannotBeSwitchedOn(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	admin1 := f.member("Ifeoma Adeyemi", admin.RoleAdmin)

	flags, err := f.svc.FeatureFlags(admin1)
	if err != nil || len(flags) < 8 {
		t.Fatalf("flags = %d, %v", len(flags), err)
	}
	_, err = f.svc.SetFeatureFlag(admin1, "international_transfers", true, "Launch")
	wantStatus(t, err, 409)
	off, err := f.svc.SetFeatureFlag(admin1, "nem_assistant", false, "Provider outage")
	if err != nil || off.Enabled || off.UpdatedBy == nil || off.UpdatedBy.Name != "Ifeoma Adeyemi" {
		t.Fatalf("switch off = %+v, %v", off, err)
	}
	if on, _ := f.svc.FlagEnabled(t.Context(), "nem_assistant"); on {
		t.Fatal("the flag is still on")
	}
	_, err = f.svc.SetFeatureFlag(admin1, "no_such_flag", true, "")
	wantStatus(t, err, 404)
	if f.count(`SELECT count(*) FROM audit_log WHERE action = 'feature_flag.set'`) != 1 {
		t.Fatal("the flag change was not audited exactly once")
	}
}

type leg struct {
	account uuid.UUID
	kobo    int64
}

// adjustment builds the request through JSON, the way a client sends it.
func adjustment(t *testing.T, reason string, legs ...leg) api.LedgerAdjustmentRequest {
	t.Helper()
	body := map[string]any{"reason": reason}
	var ps []map[string]any
	for _, l := range legs {
		ps = append(ps, map[string]any{"account_id": l.account, "amount": map[string]string{"amount_minor": fmt.Sprint(l.kobo), "currency": "NGN"}})
	}
	body["postings"] = ps
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	var req api.LedgerAdjustmentRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		t.Fatal(err)
	}
	return req
}

func TestALedgerAdjustmentPostsOnlyAfterFinanceApprovesAndTheTrialBalanceStaysZero(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	maker := f.member("Tunde Okafor", admin.RoleFinance)
	other := f.member("Aisha Bello", admin.RoleCompliance)
	checker := f.member("Ifeoma Adeyemi", admin.RoleAdmin)
	tolu := f.customer("Tolu", "tolu", naira(1_000))

	var suspense uuid.UUID
	if err := pgx.BeginFunc(t.Context(), f.pool, func(tx pgx.Tx) error {
		a, err := ledger.SystemAccount(t.Context(), tx, ledger.KindSuspense, "NGN")
		suspense = a.ID
		return err
	}); err != nil {
		t.Fatal(err)
	}
	req := adjustment(t, "Goodwill credit after a failed airtime top-up", leg{suspense, -naira(200)}, leg{tolu.account, naira(200)})

	ap, err := f.svc.RequestLedgerAdjustment(maker, req)
	if err != nil {
		t.Fatal(err)
	}
	if n := f.count(`SELECT count(*) FROM journal_entries WHERE kind = 'manual_adjustment'`); n != 0 {
		t.Fatal("the request alone posted")
	}
	// Compliance may propose adjustments but cannot approve one; the maker cannot approve their own.
	if _, err := f.admin.Approve(other, ap.Id); err == nil {
		t.Fatal("compliance approved a ledger adjustment")
	}
	_, err = f.admin.Approve(maker, ap.Id)
	wantProblem(t, err, admin.ErrSameStaff)
	if _, err := f.admin.Approve(checker, ap.Id); err != nil {
		t.Fatal(err)
	}
	var entry uuid.UUID
	var approval uuid.UUID
	if err := f.pool.QueryRow(t.Context(), `SELECT id, approval_id FROM journal_entries WHERE kind = 'manual_adjustment'`).Scan(&entry, &approval); err != nil || approval != ap.Id {
		t.Fatalf("entry %v approval %v: %v", entry, approval, err)
	}
	got, err := f.svc.JournalEntry(maker, entry)
	if err != nil || len(got.Postings) != 2 || got.ApprovalId == nil {
		t.Fatalf("entry = %+v, %v", got, err)
	}
	posts, _, err := f.svc.LedgerPostings(maker, tolu.account, api.ListLedgerPostingsParams{})
	if err != nil || len(posts) != 2 || posts[0].Amount.AmountMinor != fmt.Sprint(naira(200)) {
		t.Fatalf("postings = %+v, %v", posts, err)
	}

	later := time.Now().Add(time.Hour)
	tb, err := f.svc.TrialBalance(maker, &later)
	if err != nil || !tb.Balanced || len(tb.Currencies) == 0 {
		t.Fatalf("trial balance = %+v, %v", tb, err)
	}
	for _, l := range tb.Currencies {
		if l.Net.AmountMinor != "0" || !l.Balanced {
			t.Fatalf("%s does not net to zero: %+v", l.Currency, l)
		}
	}

	// Unbalanced, unknown or zero postings never reach the queue.
	for name, legs := range map[string][]leg{
		"unbalanced": {{suspense, -naira(100)}, {tolu.account, naira(200)}},
		"unknown":    {{uuid.New(), -naira(100)}, {tolu.account, naira(100)}},
		"zero":       {{suspense, 0}, {tolu.account, 0}},
	} {
		if _, err := f.svc.RequestLedgerAdjustment(maker, adjustment(t, "Goodwill credit after a failed top-up", legs...)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	short := req
	short.Reason = "too short"
	if _, err := f.svc.RequestLedgerAdjustment(maker, short); err == nil {
		t.Error("a short reason was accepted")
	}
}

func TestFraudCasesAreAssignedDecidedLabelledAndAudited(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	one := f.member("Aisha Bello", admin.RoleCompliance)
	two := f.member("Ifeoma Adeyemi", admin.RoleAdmin)
	agent := f.member("Chidi Eze", admin.RoleSupport)
	tolu, big, small := f.customer("Tolu", "tolu", naira(100_000)), f.customer("Big", "big", 0), f.customer("Small", "small", 0)
	for range 3 {
		if _, err := f.xfers.Create(tolu.ctx, transfers.Request{SourceAccountID: tolu.account, Destination: toNem(small.number), Amount: money.New(naira(5_000), money.NGN), Narration: "Lunch"}); err != nil {
			t.Fatal(err)
		}
	}
	v, err := f.xfers.Create(tolu.ctx, transfers.Request{SourceAccountID: tolu.account, Destination: toNem(big.number), Amount: money.New(naira(80_000), money.NGN), Narration: "Rent"})
	if err != nil || v.Status != string(transfers.HeldForReview) {
		t.Fatalf("held transfer = %s, %v, risk %s", v.Status, err, v.Risk)
	}

	page, err := f.svc.FraudCases(one, api.ListFraudCasesParams{})
	if err != nil || len(page.Data) != 1 || page.Data[0].Id != v.ID || page.Data[0].Status != "open" || len(page.Data[0].Risk.Reasons) == 0 || page.Data[0].Signals == nil {
		t.Fatalf("queue = %+v, %v", page, err)
	}
	if page.Data[0].Customer.Name != "Tolu Test" || page.Data[0].Transfer.Status != "held_for_review" {
		t.Fatalf("case = %+v", page.Data[0])
	}

	c, err := f.svc.AssignFraudCase(one, v.ID)
	if err != nil || c.Status != "in_review" || c.Assignee == nil || c.Assignee.Name != "Aisha Bello" {
		t.Fatalf("assign = %+v, %v", c, err)
	}
	// Taking it again is fine; someone else taking or deciding it is not.
	if _, err := f.svc.AssignFraudCase(one, v.ID); err != nil {
		t.Fatal(err)
	}
	_, err = f.svc.AssignFraudCase(two, v.ID)
	wantProblem(t, err, errCaseTaken)
	_, err = f.svc.DecideFraudCase(two, v.ID, api.FraudDecisionRequest{Decision: "release", Label: "legitimate"})
	wantProblem(t, err, errCaseTaken)
	mine, _ := f.svc.FraudCases(one, api.ListFraudCasesParams{Status: ptr(api.FraudCaseStatus("in_review")), AssignedToMe: ptr(true)})
	theirs, _ := f.svc.FraudCases(two, api.ListFraudCasesParams{Status: ptr(api.FraudCaseStatus("in_review")), AssignedToMe: ptr(true)})
	if len(mine.Data) != 1 || len(theirs.Data) != 0 {
		t.Fatalf("assigned_to_me: mine %d, theirs %d", len(mine.Data), len(theirs.Data))
	}

	note := "Customer confirmed by phone"
	done, err := f.svc.DecideFraudCase(one, v.ID, api.FraudDecisionRequest{Decision: "release", Label: "legitimate", Note: &note})
	if err != nil || done.Status != "released" || done.ClosedAt == nil || done.Label == nil || *done.Label != "legitimate" || done.Transfer.Status != "completed" {
		t.Fatalf("decision = %+v, %v", done, err)
	}
	var label, status string
	if err := f.pool.QueryRow(t.Context(), `SELECT label, (SELECT status FROM transfers WHERE id = $1) FROM risk_assessments WHERE transfer_id = $1`, v.ID).Scan(&label, &status); err != nil || label != "legit" || status != "completed" {
		t.Fatalf("risk label %q, transfer %q, %v", label, status, err)
	}
	_, err = f.svc.DecideFraudCase(one, v.ID, api.FraudDecisionRequest{Decision: "reject", Label: "fraud"})
	wantStatus(t, err, 409)
	closed, _ := f.svc.FraudCases(one, api.ListFraudCasesParams{Status: ptr(api.FraudCaseStatus("released"))})
	if len(closed.Data) != 1 {
		t.Fatalf("closed cases = %d", len(closed.Data))
	}
	if left, _ := f.svc.FraudCases(one, api.ListFraudCasesParams{}); len(left.Data) != 0 {
		t.Fatalf("open cases left = %d", len(left.Data))
	}
	if f.count(`SELECT count(*) FROM audit_log WHERE action IN ('fraud.assign', 'fraud.release')`) != 3 {
		t.Fatal("fraud actions were not audited")
	}
	_ = agent
}

func TestTheAuditLogPagesFiltersAndVerifies(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	maker := f.member("Aisha Bello", admin.RoleCompliance)
	tolu := f.customer("Tolu", "tolu", 0)
	for i := range 4 {
		if _, err := f.svc.AddNote(maker, tolu.id, fmt.Sprintf("Note %d", i)); err != nil {
			t.Fatal(err)
		}
	}
	two := 2
	page1, err := f.svc.AuditLog(maker, api.ListAuditLogParams{Limit: &two})
	if err != nil || len(page1.Data) != 2 || page1.Page.NextCursor == nil || page1.Data[0].Seq <= page1.Data[1].Seq {
		t.Fatalf("page 1 = %+v, %v", page1, err)
	}
	page2, err := f.svc.AuditLog(maker, api.ListAuditLogParams{Limit: &two, Cursor: page1.Page.NextCursor})
	if err != nil || len(page2.Data) == 0 || page2.Data[0].Seq >= page1.Data[1].Seq {
		t.Fatalf("page 2 = %+v, %v", page2, err)
	}
	action := "customer.note"
	notes, err := f.svc.AuditLog(maker, api.ListAuditLogParams{Action: &action})
	if err != nil || len(notes.Data) != 4 || notes.Data[0].Actor.Name == nil || *notes.Data[0].Actor.Name != "Aisha Bello" {
		t.Fatalf("filtered = %+v, %v", notes, err)
	}

	v, err := f.svc.VerifyAuditLog(maker, nil, nil)
	if err != nil || !v.Valid || v.FirstBrokenSeq != nil || v.Checked < 4 {
		t.Fatalf("verify = %+v, %v", v, err)
	}
	// Verification is itself a line in the log.
	if f.count(`SELECT count(*) FROM audit_log WHERE action = 'audit.verify'`) != 1 {
		t.Fatal("verify not logged")
	}
}

func TestTheDashboardCountsTheBank(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	maker := f.member("Aisha Bello", admin.RoleCompliance)
	tolu, ada := f.customer("Tolu", "tolu", naira(50_000)), f.customer("Ada", "ada", 0)
	if _, err := f.xfers.Create(tolu.ctx, transfers.Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: money.New(naira(2_000), money.NGN), Narration: "Lunch"}); err != nil {
		t.Fatal(err)
	}
	d, err := f.svc.Dashboard(maker, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if d.UsersTotal != 2 || d.UsersNew != 2 || len(d.Volume) != 1 || d.Volume[0].Currency != "NGN" || len(d.TransfersByStatus) != 1 || d.TransfersByStatus[0].Count != 1 {
		t.Fatalf("dashboard = %+v", d)
	}
	// A period in the past sees none of today's activity; a backwards one is refused.
	past := time.Now().AddDate(0, -3, 0)
	pastEnd := past.AddDate(0, 0, 5)
	old, err := f.svc.Dashboard(maker, &past, &pastEnd)
	if err != nil || old.UsersNew != 0 || len(old.TransfersByStatus) != 0 {
		t.Fatalf("old period = %+v, %v", old, err)
	}
	_, err = f.svc.Dashboard(maker, &pastEnd, &past)
	wantStatus(t, err, 400)
}

func TestKYCPhotoLinksAreSignedExpireAndNameTheirStaffMember(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	staffID, sub, doc := uuid.New(), uuid.New(), uuid.New()
	exp := f.clock().Add(time.Minute).Unix()
	good := f.svc.signDoc(staffID, sub, doc, exp)

	get := func(sig, rawExp, who string) int {
		rec := httptest.NewRecorder()
		f.svc.ServeDocument(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/", nil), sub.String(), doc.String(), who, rawExp, sig)
		return rec.Code
	}
	// A bad signature, another staff member's link, an expired link and junk are all a plain 404.
	if get("nope", fmt.Sprint(exp), staffID.String()) != 404 || get(good, fmt.Sprint(exp), uuid.NewString()) != 404 ||
		get(good, fmt.Sprint(exp-3600), staffID.String()) != 404 || get(good, "x", "y") != 404 {
		t.Fatal("a bad link was served")
	}
	// A valid link for a staff member who does not exist, or a photo that does not exist, is 404 too.
	if get(good, fmt.Sprint(exp), staffID.String()) != 404 {
		t.Fatal("a link to nothing was served")
	}
	if !strings.HasPrefix(f.svc.docURL(staffID, sub, doc), "/v1/admin/kyc/documents/"+sub.String()+"/"+doc.String()+"?staff=") {
		t.Fatal("link shape changed")
	}
}

func TestALargeDisputeRefundWaitsForASecondMemberAndPostsOnApproval(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	maker := f.member("Aisha Bello", admin.RoleCompliance)
	checker := f.member("Ifeoma Adeyemi", admin.RoleAdmin)
	agent := f.member("Chidi Eze", admin.RoleSupport)
	tolu, ada := f.customer("Tolu", "tolu", naira(100_000)), f.customer("Ada", "ada", 0)
	v, err := f.xfers.Create(tolu.ctx, transfers.Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: money.New(naira(2_000), money.NGN), Narration: "Gadget"})
	if err != nil || v.Status != "completed" {
		t.Fatalf("transfer = %s, %v", v.Status, err)
	}
	d, err := f.disp.CreateDispute(tolu.ctx, support.CreateDisputeRequest{TransactionID: v.TransactionID, Reason: "other", Description: "The gadget never arrived."})
	if err != nil {
		t.Fatal(err)
	}
	balance := func() string {
		var b int64
		if err := f.pool.QueryRow(t.Context(), `SELECT balance_minor FROM ledger_accounts WHERE id = $1`, tolu.account).Scan(&b); err != nil {
			t.Fatal(err)
		}
		return fmt.Sprint(b)
	}
	before := balance()

	// Opening a case moves it under review; asking for more needs no approval.
	if got, err := f.svc.Dispute(agent, d.Id); err != nil || got.Dispute.Status != "under_review" || got.Transaction.Id != v.TransactionID {
		t.Fatalf("open = %+v, %v", got, err)
	}
	if got, ap, err := f.svc.DecideDispute(maker, d.Id, api.DisputeDecisionRequest{Outcome: "request_info", Note: "Please send the seller's receipt."}); err != nil || ap != nil || got.Dispute.Status != "awaiting_customer" {
		t.Fatalf("request_info = %+v, %v, %v", got, ap, err)
	}

	refund := api.DisputeDecisionRequest{Outcome: "refund", Note: "Seller confirmed non-delivery.", RefundAmount: &api.Money{AmountMinor: fmt.Sprint(naira(1_500)), Currency: "NGN"}}
	got, ap, err := f.svc.DecideDispute(maker, d.Id, refund)
	if err != nil || got != nil || ap == nil || ap.Status != "pending" || ap.Action != "dispute_refund" {
		t.Fatalf("large refund = %+v, %+v, %v", got, ap, err)
	}
	if balance() != before {
		t.Fatal("the refund posted before anyone approved it")
	}
	if _, err := f.admin.Approve(maker, ap.Id); err == nil {
		t.Fatal("the maker approved their own refund")
	}
	if _, err := f.admin.Approve(checker, ap.Id); err != nil {
		t.Fatal(err)
	}
	after, err := f.svc.Dispute(agent, d.Id)
	if err != nil || after.Dispute.Status != "resolved_refunded" {
		t.Fatalf("after approval = %+v, %v", after.Dispute.Status, err)
	}
	if balance() == before || f.count(`SELECT count(*) FROM journal_entries WHERE kind = 'dispute_refund'`) != 1 {
		t.Fatal("the approved refund did not post exactly once")
	}
	// A closed dispute takes no further decisions.
	if _, _, err := f.svc.DecideDispute(maker, d.Id, refund); err == nil {
		t.Fatal("a closed dispute accepted a second decision")
	}
}
