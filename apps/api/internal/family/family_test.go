package family

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync/atomic"
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
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers"
)

// dbCustomers reads profiles from the users table, so dependants (made by the service under
// test) have one too.
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

// stepUps accepts the token "ok" once.
type stepUps struct{}

func (stepUps) ConsumeStepUp(_ context.Context, _ pgx.Tx, _ uuid.UUID, purpose, token string) error {
	if purpose != StepUpPurpose || token != "ok" {
		return identity.ErrStepUpRequired
	}
	return nil
}

type fixture struct {
	t     *testing.T
	pool  *pgxpool.Pool
	accts *accounts.Service
	xfers *transfers.Service
	svc   *Service
	now   atomic.Pointer[time.Time]
	n     atomic.Int32
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	pool := testdb.New(t)
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	f := &fixture{t: t, pool: pool}
	start := time.Date(2026, 11, 11, 9, 0, 0, 0, time.UTC)
	f.now.Store(&start)
	clock := func() time.Time { return *f.now.Load() }
	cust := dbCustomers{pool}
	var err error
	f.accts, err = accounts.NewService(accounts.Config{
		Pool: pool, Customers: cust, Logger: quiet,
		Timelines: func(ctx context.Context, id uuid.UUID) ([]api.TimelineEvent, error) { return f.xfers.Timeline(ctx, id) },
	})
	if err != nil {
		t.Fatal(err)
	}
	lim, err := limits.NewService(limits.Config{Pool: pool, Customers: cust, Now: clock})
	if err != nil {
		t.Fatal(err)
	}
	if f.xfers, err = transfers.NewService(transfers.Config{Pool: pool, Accounts: f.accts, Customers: cust, Limits: lim, Logger: quiet, Now: clock}); err != nil {
		t.Fatal(err)
	}
	if f.svc, err = NewService(Config{
		Pool: pool, Accounts: f.accts, Customers: cust, StepUps: stepUps{}, Sender: f.xfers, Limits: lim,
		CodeKey: make([]byte, 32), Logger: quiet, Now: clock,
	}); err != nil {
		t.Fatal(err)
	}
	f.xfers.SetFamily(f.svc)
	return f
}

func (f *fixture) advance(d time.Duration) {
	n := f.now.Load().Add(d)
	f.now.Store(&n)
}

type person struct {
	ctx     context.Context
	id      uuid.UUID
	account uuid.UUID
	number  string
}

// customer is an adult with an NGN account holding balance kobo.
func (f *fixture) customer(name, tag string, balance int64) person {
	f.t.Helper()
	ctx := f.t.Context()
	id := uuid.New()
	n := f.n.Add(1)
	if _, err := f.pool.Exec(ctx, `INSERT INTO users (id, first_name, last_name, email, phone, nemtag, date_of_birth,
		password_hash, kyc_tier, terms_version, privacy_version, consent_accepted_at)
		VALUES ($1, $2, 'Test', $3, $4, $5, '1985-04-12', 'x', 2, '2026-10', '2026-10', now())`,
		id, name, fmt.Sprintf("f%d@example.com", n), fmt.Sprintf("+2348032%06d", n), tag); err != nil {
		f.t.Fatal(err)
	}
	if err := pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		return accounts.OpenCurrentAccount(ctx, tx, identity.NewCustomer{UserID: id, Name: name + " Test"})
	}); err != nil {
		f.t.Fatal(err)
	}
	p := person{ctx: identity.WithPrincipal(ctx, identity.Principal{UserID: id, DeviceID: uuid.New()}), id: id}
	p.account, p.number = f.nairaAccount(id)
	f.fund(p.account, balance)
	return p
}

func (f *fixture) nairaAccount(user uuid.UUID) (uuid.UUID, string) {
	f.t.Helper()
	var id uuid.UUID
	var number string
	if err := f.pool.QueryRow(f.t.Context(), `SELECT account_id, account_number FROM customer_accounts WHERE user_id = $1 AND currency = 'NGN'`, user).Scan(&id, &number); err != nil {
		f.t.Fatal(err)
	}
	return id, number
}

func (f *fixture) fund(account uuid.UUID, kobo int64) {
	f.t.Helper()
	if kobo == 0 {
		return
	}
	ctx := f.t.Context()
	if err := pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		src, err := ledger.SystemAccount(ctx, tx, ledger.KindDemoFunding, "NGN")
		if err != nil {
			return err
		}
		_, err = ledger.Post(ctx, tx, ledger.Entry{Kind: "demo_funding", Reference: "seed-" + uuid.NewString(),
			Legs: []ledger.Leg{ledger.Debit(src.ID, nairaMoney(kobo)), ledger.Credit(account, nairaMoney(kobo))}})
		return err
	}); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) balances(account uuid.UUID) (ledgerBal, available int64) {
	f.t.Helper()
	b, err := ledger.GetBalances(f.t.Context(), f.pool, account)
	if err != nil {
		f.t.Fatal(err)
	}
	return b.Ledger.Amount(), b.Available.Amount()
}

func nairaMoney(minor int64) money.Money { return money.New(minor, money.NGN) }

func naira(n int64) int64 { return n * 100 }

func apiMoney(minor int64) api.Money { return accounts.Money(nairaMoney(minor)) }

func toNem(number string) api.TransferDestination {
	var d api.TransferDestination
	if err := d.FromNemDestination(api.NemDestination{Kind: api.NemDestinationKindNem, AccountNumber: number}); err != nil {
		panic(err)
	}
	return d
}

func controlsOf(daily, threshold int64) api.DependantControls {
	return api.DependantControls{DailySpendLimit: apiMoney(daily), ApprovalThreshold: apiMoney(threshold), CanSendToBanks: true}
}

func dob(years int) time.Time {
	return time.Date(2026-years, 1, 15, 0, 0, 0, 0, time.UTC)
}

type kid struct {
	person
	dep api.Dependant
}

// dependant adds one under parent, funded with balance kobo.
func (f *fixture) dependant(parent person, tag string, c api.DependantControls, balance int64) kid {
	f.t.Helper()
	out, err := f.svc.CreateDependant(parent.ctx, NewDependant{FirstName: "Kemi", LastName: "Test", DateOfBirth: dob(12), Nemtag: tag, Controls: c}, "ok")
	if err != nil {
		f.t.Fatal(err)
	}
	k := kid{dep: out.Dependant}
	k.id = out.Dependant.Profile.UserId
	k.ctx = identity.WithPrincipal(f.t.Context(), identity.Principal{UserID: k.id, DeviceID: uuid.New()})
	k.account, k.number = f.nairaAccount(k.id)
	f.fund(k.account, balance)
	return k
}

func problemCode(err error) string {
	var p *problem.Error
	if errors.As(err, &p) {
		return p.Code
	}
	return ""
}

func (f *fixture) send(from person, to person, kobo int64, narration string) (transfers.View, error) {
	return f.xfers.Create(from.ctx, transfers.Request{
		SourceAccountID: from.account, Destination: toNem(to.number), Amount: nairaMoney(kobo), Narration: narration,
	})
}

func TestCreateDependantMakesAnAccountAndASetupCode(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	parent := f.customer("Ada", "ada_p", 0)
	out, err := f.svc.CreateDependant(parent.ctx, NewDependant{FirstName: " Kemi ", LastName: "Okoro", DateOfBirth: dob(12), Nemtag: "@Kemi_O", Controls: controlsOf(naira(5000), naira(2000))}, "ok")
	if err != nil {
		t.Fatal(err)
	}
	d := out.Dependant
	if d.Profile.Name != "Kemi Okoro" || d.Profile.Nemtag == nil || *d.Profile.Nemtag != "kemi_o" || !d.KidMode {
		t.Fatalf("profile = %+v kid=%v", d.Profile, d.KidMode)
	}
	if d.Balance.AmountMinor != "0" || d.Allowance != nil || d.Controls.Paused {
		t.Fatalf("dependant = %+v", d)
	}
	if len(out.SetupCode) != 8 || !out.SetupCodeExpiresAt.After(f.now.Load().UTC()) {
		t.Fatalf("setup code = %q until %v", out.SetupCode, out.SetupCodeExpiresAt)
	}
	// The user row is a dependant on the parent's contact details, with an account of their own.
	var isDep bool
	var guardian uuid.UUID
	var email string
	if err := f.pool.QueryRow(t.Context(), `SELECT is_dependant, guardian_id, email FROM users WHERE id = $1`, d.Profile.UserId).Scan(&isDep, &guardian, &email); err != nil {
		t.Fatal(err)
	}
	if !isDep || guardian != parent.id || email != "f1@example.com" {
		t.Fatalf("user row: dependant=%v guardian=%v email=%q", isDep, guardian, email)
	}
	if acct, _ := f.nairaAccount(d.Profile.UserId); acct != d.AccountId {
		t.Fatalf("account = %v, want %v", acct, d.AccountId)
	}
	// The code works for that dependant until it expires, and not for a wrong code.
	if ok, err := f.svc.CheckSetupCode(t.Context(), d.Id, out.SetupCode); err != nil || !ok {
		t.Fatalf("right code: ok=%v err=%v", ok, err)
	}
	if ok, _ := f.svc.CheckSetupCode(t.Context(), d.Id, "00000000"); ok {
		t.Fatal("wrong code accepted")
	}
	f.advance(SetupCodeTTL + time.Minute)
	if ok, _ := f.svc.CheckSetupCode(t.Context(), d.Id, out.SetupCode); ok {
		t.Fatal("expired code accepted")
	}
	// The parent lists them; their sign-in email still belongs to the parent alone.
	list, err := f.svc.Dependants(parent.ctx)
	if err != nil || len(list) != 1 || list[0].Id != d.Id {
		t.Fatalf("list = %+v err=%v", list, err)
	}
	var byEmail int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM users WHERE email = $1 AND NOT is_dependant`, email).Scan(&byEmail); err != nil || byEmail != 1 {
		t.Fatalf("sign-in users with that email = %d err=%v", byEmail, err)
	}
}

func TestCreateDependantRefusals(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	parent := f.customer("Ada", "ada_p", 0)
	other := f.customer("Bola", "bola_p", 0)
	base := NewDependant{FirstName: "Kemi", LastName: "Okoro", DateOfBirth: dob(12), Nemtag: "kemi_o", Controls: controlsOf(naira(5000), naira(2000))}
	with := func(edit func(*NewDependant)) NewDependant { n := base; edit(&n); return n }

	for name, tc := range map[string]struct {
		in   NewDependant
		step string
		code string
	}{
		"too young":        {with(func(n *NewDependant) { n.DateOfBirth = dob(5) }), "ok", problem.CodeValidationFailed},
		"already an adult": {with(func(n *NewDependant) { n.DateOfBirth = dob(18) }), "ok", problem.CodeValidationFailed},
		"reserved tag":     {with(func(n *NewDependant) { n.Nemtag = "admin" }), "ok", problem.CodeValidationFailed},
		"bad tag":          {with(func(n *NewDependant) { n.Nemtag = "9x" }), "ok", problem.CodeValidationFailed},
		"no name":          {with(func(n *NewDependant) { n.FirstName = "  " }), "ok", problem.CodeValidationFailed},
		"zero limit":       {with(func(n *NewDependant) { n.Controls = controlsOf(0, naira(10)) }), "ok", problem.CodeValidationFailed},
		"taken tag":        {with(func(n *NewDependant) { n.Nemtag = "ada_p" }), "ok", "nemtag_taken"},
	} {
		if _, err := f.svc.CreateDependant(parent.ctx, tc.in, tc.step); problemCode(err) != tc.code {
			t.Errorf("%s: code = %q (%v), want %q", name, problemCode(err), err, tc.code)
		}
	}
	if _, err := f.svc.CreateDependant(parent.ctx, base, "wrong"); !errors.Is(err, identity.ErrStepUpRequired) {
		t.Errorf("no step-up: %v", err)
	}
	// A refused request leaves nothing behind: no user, no account.
	var users int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM users WHERE is_dependant`).Scan(&users); err != nil || users != 0 {
		t.Errorf("dependants after refusals = %d err=%v", users, err)
	}

	// The sixth dependant is refused.
	for i := range MaxDependants {
		n := with(func(n *NewDependant) { n.Nemtag = fmt.Sprintf("kid_%d", i) })
		if _, err := f.svc.CreateDependant(parent.ctx, n, "ok"); err != nil {
			t.Fatalf("dependant %d: %v", i, err)
		}
	}
	if _, err := f.svc.CreateDependant(parent.ctx, with(func(n *NewDependant) { n.Nemtag = "kid_six" }), "ok"); problemCode(err) != problem.CodeConflict {
		t.Errorf("sixth dependant: %v", err)
	}
	// Someone else's dependants are not mine to read or change.
	if list, err := f.svc.Dependants(other.ctx); err != nil || len(list) != 0 {
		t.Errorf("stranger's list = %d err=%v", len(list), err)
	}
	mine, _ := f.svc.Dependants(parent.ctx)
	if _, err := f.svc.Dependant(other.ctx, mine[0].Id); problemCode(err) != problem.CodeNotFound {
		t.Errorf("stranger reads dependant: %v", err)
	}
	if _, err := f.svc.UpdateControls(other.ctx, mine[0].Id, api.UpdateDependantRequest{KidMode: new(bool)}); problemCode(err) != problem.CodeNotFound {
		t.Errorf("stranger edits dependant: %v", err)
	}
	// A dependant cannot add dependants of their own.
	kidCtx := identity.WithPrincipal(t.Context(), identity.Principal{UserID: mine[0].Profile.UserId})
	if _, err := f.svc.CreateDependant(kidCtx, base, "ok"); problemCode(err) != problem.CodeForbidden {
		t.Errorf("dependant adds dependant: %v", err)
	}
}

func TestSmallTransfersGoWithinTheControls(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	parent := f.customer("Ada", "ada_p", naira(10_000))
	friend := f.customer("Chi", "chi_f", 0)
	k := f.dependant(parent, "kemi_o", controlsOf(naira(5000), naira(2000)), naira(10_000))

	v, err := f.send(k.person, friend, naira(1500), "lunch")
	if err != nil || v.Status != "completed" {
		t.Fatalf("within threshold: status=%v err=%v", v.Status, err)
	}
	if bal, _ := f.balances(friend.account); bal != naira(1500) {
		t.Fatalf("friend balance = %d", bal)
	}
	// ₦1,500 sent, then ₦1,900: ₦1,600 is left of the ₦5,000 day, so ₦1,700 (under the
	// approval threshold) is refused for the daily limit alone.
	if _, err := f.send(k.person, friend, naira(1900), "snacks"); err != nil {
		t.Fatal(err)
	}
	_, err = f.send(k.person, friend, naira(1700), "more")
	if problemCode(err) != limits.CodeLimitExceeded {
		t.Fatalf("over the daily limit: %v", err)
	}
	// The next day the limit is fresh.
	f.advance(24 * time.Hour)
	if _, err := f.send(k.person, friend, naira(1000), "next day"); err != nil {
		t.Fatalf("next day: %v", err)
	}
	// A paused dependant sends nothing.
	if _, err := f.svc.UpdateControls(parent.ctx, k.dep.Id, api.UpdateDependantRequest{Controls: &api.DependantControls{
		DailySpendLimit: apiMoney(naira(5000)), ApprovalThreshold: apiMoney(naira(2000)), CanSendToBanks: true, Paused: true,
	}}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.send(k.person, friend, naira(100), "paused"); problemCode(err) != "family_paused" {
		t.Fatalf("paused: %v", err)
	}
	// Grown-ups are untouched by all of this.
	if _, err := f.send(parent, friend, naira(3000), "adult"); err != nil {
		t.Fatalf("the parent: %v", err)
	}
}

func TestBankTransfersCanBeSwitchedOff(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	parent := f.customer("Ada", "ada_p", 0)
	c := controlsOf(naira(5000), naira(2000))
	c.CanSendToBanks = false
	k := f.dependant(parent, "kemi_o", c, naira(10_000))
	err := f.svc.Screen(t.Context(), transfers.FamilyCheck{
		UserID: k.id, Request: transfers.Request{SourceAccountID: k.account}, Amount: nairaMoney(naira(500)), Total: nairaMoney(naira(552)), Interbank: true,
	})
	if problemCode(err) != "family_bank_transfers_off" {
		t.Fatalf("interbank: %v", err)
	}
	// The same transfer to a Nem user is fine, and a grown-up is never screened.
	if err := f.svc.Screen(t.Context(), transfers.FamilyCheck{UserID: k.id, Amount: nairaMoney(naira(500)), Total: nairaMoney(naira(500))}); err != nil {
		t.Fatalf("nem transfer: %v", err)
	}
	if err := f.svc.Screen(t.Context(), transfers.FamilyCheck{UserID: parent.id, Interbank: true, Amount: nairaMoney(naira(500))}); err != nil {
		t.Fatalf("adult: %v", err)
	}
}

// ask has the dependant try a transfer above their threshold and returns the approval it made.
func (f *fixture) ask(k kid, to person, kobo int64) api.FamilyApproval {
	f.t.Helper()
	_, err := f.send(k.person, to, kobo, "textbooks")
	if problemCode(err) != "parent_approval_required" {
		f.t.Fatalf("above threshold: %v", err)
	}
	list, err := f.svc.Approvals(k.ctx, nil)
	if err != nil || len(list) == 0 {
		f.t.Fatalf("dependant's approvals = %d err=%v", len(list), err)
	}
	return list[0]
}

func TestApprovingSendsTheTransferAsTheDependant(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	parent := f.customer("Ada", "ada_p", 0)
	friend := f.customer("Chi", "chi_f", 0)
	k := f.dependant(parent, "kemi_o", controlsOf(naira(20_000), naira(2000)), naira(10_000))

	a := f.ask(k, friend, naira(4000))
	if a.Status != "pending" || a.Amount.AmountMinor != "400000" || a.Dependant.UserId != k.id || a.Recipient.Name != "Chi Test" || !a.ExpiresAt.After(a.CreatedAt) {
		t.Fatalf("approval = %+v", a)
	}
	// Nothing has gone yet, but the money is set aside (an internal transfer has no fee), and
	// asking again does not make a second request or set aside more.
	bal, avail := f.balances(k.account)
	if bal != naira(10_000) || avail != naira(6000) {
		t.Fatalf("balance = %d available = %d", bal, avail)
	}
	if _, err := f.send(k.person, friend, naira(4000), "textbooks"); problemCode(err) != "parent_approval_required" {
		t.Fatal(err)
	}
	if list, _ := f.svc.Approvals(parent.ctx, nil); len(list) != 1 {
		t.Fatalf("parent sees %d approvals", len(list))
	}
	if _, availAgain := f.balances(k.account); availAgain != avail {
		t.Fatalf("available changed on a retry: %d -> %d", avail, availAgain)
	}
	// Only the parent can answer.
	stranger := f.customer("Dee", "dee_s", 0)
	if _, err := f.svc.Approve(stranger.ctx, uuid.MustParse(a.Id.String())); problemCode(err) != problem.CodeNotFound {
		t.Fatalf("stranger approves: %v", err)
	}
	if _, err := f.svc.Approve(k.ctx, a.Id); problemCode(err) != problem.CodeNotFound {
		t.Fatalf("the dependant approves their own: %v", err)
	}

	done, err := f.svc.Approve(parent.ctx, a.Id)
	if err != nil || done.Status != "approved" || done.TransferId == nil {
		t.Fatalf("approve: %+v err=%v", done, err)
	}
	if got, _ := f.balances(friend.account); got != naira(4000) {
		t.Fatalf("friend got %d", got)
	}
	if got, avail := f.balances(k.account); got != naira(6000) || avail != naira(6000) {
		t.Fatalf("dependant ends with %d (available %d), want 6000 and the hold gone", got, avail)
	}
	var status, userID string
	if err := f.pool.QueryRow(t.Context(), `SELECT status, user_id::text FROM transfers WHERE id = $1`, *done.TransferId).Scan(&status, &userID); err != nil {
		t.Fatal(err)
	}
	if status != "completed" || userID != k.id.String() {
		t.Fatalf("transfer %s by %s", status, userID)
	}
	// Answering twice is refused, and the money moved once.
	if _, err := f.svc.Approve(parent.ctx, a.Id); problemCode(err) != "invalid_state" {
		t.Fatalf("second approve: %v", err)
	}
	if _, err := f.svc.Decline(parent.ctx, a.Id); problemCode(err) != "invalid_state" {
		t.Fatalf("decline after approve: %v", err)
	}
	if got, _ := f.balances(friend.account); got != naira(4000) {
		t.Fatalf("friend got %d after the repeats", got)
	}
}

func TestDecliningAndExpiryGiveTheMoneyBack(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	parent := f.customer("Ada", "ada_p", 0)
	friend := f.customer("Chi", "chi_f", 0)
	k := f.dependant(parent, "kemi_o", controlsOf(naira(20_000), naira(2000)), naira(10_000))

	a := f.ask(k, friend, naira(4000))
	if _, avail := f.balances(k.account); avail == naira(10_000) {
		t.Fatal("nothing was set aside")
	}
	d, err := f.svc.Decline(parent.ctx, a.Id)
	if err != nil || d.Status != "declined" || d.TransferId != nil {
		t.Fatalf("decline: %+v err=%v", d, err)
	}
	if bal, avail := f.balances(k.account); bal != naira(10_000) || avail != naira(10_000) {
		t.Fatalf("after decline balance=%d available=%d", bal, avail)
	}

	// An unanswered request lapses after a day, and the clock gives the money back.
	b := f.ask(k, friend, naira(3000))
	f.advance(ApprovalTTL - time.Minute)
	if err := f.svc.ExpireDue(t.Context()); err != nil {
		t.Fatal(err)
	}
	if list, _ := f.svc.Approvals(parent.ctx, strPtr("pending")); len(list) != 1 || list[0].Id != b.Id {
		t.Fatalf("pending before the deadline = %+v", list)
	}
	f.advance(2 * time.Minute)
	if _, err := f.svc.Approve(parent.ctx, b.Id); problemCode(err) != "invalid_state" {
		t.Fatalf("approve after the deadline: %v", err)
	}
	if err := f.svc.ExpireDue(t.Context()); err != nil {
		t.Fatal(err)
	}
	if list, _ := f.svc.Approvals(parent.ctx, strPtr("expired")); len(list) != 1 || list[0].Id != b.Id {
		t.Fatalf("expired = %+v", list)
	}
	if bal, avail := f.balances(k.account); bal != naira(10_000) || avail != naira(10_000) {
		t.Fatalf("after expiry balance=%d available=%d", bal, avail)
	}
	// Running the clock again changes nothing.
	if err := f.svc.ExpireDue(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func strPtr(s string) *string { return &s }

func TestWaitingRequestsCountAgainstTheDailyLimit(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	parent := f.customer("Ada", "ada_p", 0)
	friend := f.customer("Chi", "chi_f", 0)
	k := f.dependant(parent, "kemi_o", controlsOf(naira(5000), naira(2000)), naira(10_000))
	f.ask(k, friend, naira(4000))
	// ₦4,000 is waiting, so only ₦1,000 of the ₦5,000 day is left.
	if _, err := f.send(k.person, friend, naira(1500), "x"); problemCode(err) != limits.CodeLimitExceeded {
		t.Fatalf("over what is left: %v", err)
	}
	if _, err := f.send(k.person, friend, naira(900), "y"); err != nil {
		t.Fatalf("inside what is left: %v", err)
	}
}

func TestAskingWithoutEnoughMoneyIsRefused(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	parent := f.customer("Ada", "ada_p", 0)
	friend := f.customer("Chi", "chi_f", 0)
	k := f.dependant(parent, "kemi_o", controlsOf(naira(20_000), naira(2000)), naira(3000))
	_, err := f.send(k.person, friend, naira(4000), "too much")
	if problemCode(err) != "insufficient_funds" {
		t.Fatalf("err = %v", err)
	}
	if list, _ := f.svc.Approvals(parent.ctx, nil); len(list) != 0 {
		t.Fatalf("an unaffordable request made %d approvals", len(list))
	}
}

func TestAllowancePaysOnScheduleOnce(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	parent := f.customer("Ada", "ada_p", naira(100_000))
	k := f.dependant(parent, "kemi_o", controlsOf(naira(20_000), naira(2000)), 0)

	got, err := f.svc.SetAllowance(parent.ctx, k.dep.Id, api.Allowance{Amount: apiMoney(naira(5000)), Frequency: api.AllowanceFrequencyMonthly, Day: ptr(15), SourceAccountId: parent.account})
	if err != nil || got.Allowance == nil || got.Allowance.NextRunAt == nil {
		t.Fatalf("set: %+v err=%v", got.Allowance, err)
	}
	// Clock: 11 Nov 09:00 UTC → the 15th at 08:00 Lagos is 07:00 UTC.
	if want := time.Date(2026, 11, 15, 7, 0, 0, 0, time.UTC); !got.Allowance.NextRunAt.Equal(want) {
		t.Fatalf("next run = %v, want %v", got.Allowance.NextRunAt, want)
	}
	if err := f.svc.RunDue(t.Context()); err != nil {
		t.Fatal(err)
	}
	if bal, _ := f.balances(k.account); bal != 0 {
		t.Fatalf("paid before its day: %d", bal)
	}
	f.advance(4*24*time.Hour + time.Hour) // 15 Nov 10:00 UTC
	for range 2 {                         // a second pass finds nothing due
		if err := f.svc.RunDue(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	if bal, _ := f.balances(k.account); bal != naira(5000) {
		t.Fatalf("dependant has %d after the run", bal)
	}
	if bal, _ := f.balances(parent.account); bal > naira(95_000) || bal < naira(94_900) {
		t.Fatalf("parent has %d (₦5,000 plus at most a fee out)", bal)
	}
	after, err := f.svc.Dependant(parent.ctx, k.dep.Id)
	if err != nil {
		t.Fatal(err)
	}
	if want := time.Date(2026, 12, 15, 7, 0, 0, 0, time.UTC); !after.Allowance.NextRunAt.Equal(want) {
		t.Fatalf("next run after paying = %v, want %v", after.Allowance.NextRunAt, want)
	}
	// The payment shows in the dependant's activity, for the parent.
	rows, _, err := f.svc.Activity(parent.ctx, k.dep.Id, nil, nil)
	if err != nil || len(rows) != 1 {
		t.Fatalf("activity = %d rows err=%v", len(rows), err)
	}
	if string(rows[0].Direction) != "credit" {
		t.Fatalf("activity direction = %v", rows[0].Direction)
	}
	// Stopping it stops it.
	if err := f.svc.StopAllowance(parent.ctx, k.dep.Id); err != nil {
		t.Fatal(err)
	}
	f.advance(31 * 24 * time.Hour)
	if err := f.svc.RunDue(t.Context()); err != nil {
		t.Fatal(err)
	}
	if bal, _ := f.balances(k.account); bal != naira(5000) {
		t.Fatalf("paid after stopping: %d", bal)
	}
}

func TestAllowanceThatCannotBePaidMovesOnAndTellsTheParent(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	parent := f.customer("Ada", "ada_p", naira(1000))
	k := f.dependant(parent, "kemi_o", controlsOf(naira(20_000), naira(2000)), 0)
	if _, err := f.svc.SetAllowance(parent.ctx, k.dep.Id, api.Allowance{Amount: apiMoney(naira(5000)), Frequency: api.AllowanceFrequencyWeekly, SourceAccountId: parent.account}); err != nil {
		t.Fatal(err)
	}
	f.advance(8 * 24 * time.Hour)
	if err := f.svc.RunDue(t.Context()); err != nil {
		t.Fatal(err)
	}
	if bal, _ := f.balances(k.account); bal != 0 {
		t.Fatalf("dependant has %d", bal)
	}
	var failed int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM outbox_events WHERE topic = $1`, TopicAllowanceFailed).Scan(&failed); err != nil || failed != 1 {
		t.Fatalf("failure events = %d err=%v", failed, err)
	}
	after, _ := f.svc.Dependant(parent.ctx, k.dep.Id)
	if after.Allowance == nil || !after.Allowance.NextRunAt.After(*f.now.Load()) {
		t.Fatalf("allowance did not move on: %+v", after.Allowance)
	}
	// Once the money is there, the next date pays.
	f.fund(parent.account, naira(10_000))
	f.advance(8 * 24 * time.Hour)
	if err := f.svc.RunDue(t.Context()); err != nil {
		t.Fatal(err)
	}
	if bal, _ := f.balances(k.account); bal != naira(5000) {
		t.Fatalf("dependant has %d after the retry date", bal)
	}
}

func TestAllowanceRefusals(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	parent := f.customer("Ada", "ada_p", 0)
	other := f.customer("Bola", "bola_p", 0)
	k := f.dependant(parent, "kemi_o", controlsOf(naira(20_000), naira(2000)), 0)
	good := api.Allowance{Amount: apiMoney(naira(500)), Frequency: api.AllowanceFrequencyWeekly, SourceAccountId: parent.account}
	with := func(edit func(*api.Allowance)) api.Allowance { a := good; edit(&a); return a }

	for name, tc := range map[string]struct {
		who  person
		a    api.Allowance
		code string
	}{
		"zero amount":            {parent, with(func(a *api.Allowance) { a.Amount = apiMoney(0) }), problem.CodeValidationFailed},
		"weekday out of range":   {parent, with(func(a *api.Allowance) { a.Day = ptr(8) }), problem.CodeValidationFailed},
		"month day too late":     {parent, with(func(a *api.Allowance) { a.Frequency = api.AllowanceFrequencyMonthly; a.Day = ptr(29) }), problem.CodeValidationFailed},
		"someone else's account": {parent, with(func(a *api.Allowance) { a.SourceAccountId = other.account }), problem.CodeNotFound},
		"not their parent":       {other, with(func(a *api.Allowance) { a.SourceAccountId = other.account }), problem.CodeNotFound},
	} {
		if _, err := f.svc.SetAllowance(tc.who.ctx, k.dep.Id, tc.a); problemCode(err) != tc.code {
			t.Errorf("%s: code = %q (%v), want %q", name, problemCode(err), err, tc.code)
		}
	}
	if err := f.svc.StopAllowance(other.ctx, k.dep.Id); problemCode(err) != problem.CodeNotFound {
		t.Errorf("stranger stops: %v", err)
	}
	// Stopping one that was never set is fine.
	if err := f.svc.StopAllowance(parent.ctx, k.dep.Id); err != nil {
		t.Errorf("stop unset: %v", err)
	}
}

func TestNextRun(t *testing.T) {
	t.Parallel()
	at := func(y int, m time.Month, d, h int) time.Time { return time.Date(y, m, d, h, 0, 0, 0, lagos) }
	for _, tc := range []struct {
		name string
		from time.Time
		freq string
		day  int
		want time.Time
	}{
		{"weekly, later this week", at(2026, 11, 11, 9), "weekly", 5, at(2026, 11, 13, 8)},       // Wed → Fri
		{"weekly, same day before 08:00", at(2026, 11, 13, 6), "weekly", 5, at(2026, 11, 13, 8)}, // Fri 06:00 → Fri 08:00
		{"weekly, same day after 08:00", at(2026, 11, 13, 9), "weekly", 5, at(2026, 11, 20, 8)},  // Fri 09:00 → next Fri
		{"weekly, Sunday is 7", at(2026, 11, 11, 9), "weekly", 7, at(2026, 11, 15, 8)},           // Wed → Sun
		{"weekly, Monday is 1", at(2026, 11, 15, 9), "weekly", 1, at(2026, 11, 16, 8)},           // Sun → Mon
		{"monthly, later this month", at(2026, 11, 11, 9), "monthly", 20, at(2026, 11, 20, 8)},   //
		{"monthly, already passed", at(2026, 11, 11, 9), "monthly", 3, at(2026, 12, 3, 8)},       //
		{"monthly, across the year end", at(2026, 12, 20, 9), "monthly", 10, at(2027, 1, 10, 8)}, //
		{"monthly, a run just paid", at(2026, 11, 15, 8), "monthly", 15, at(2026, 12, 15, 8)},    //
		{"weekly, a run just paid", at(2026, 11, 13, 8), "weekly", 5, at(2026, 11, 20, 8)},       //
		{"monthly, the 28th in February", at(2027, 2, 1, 9), "monthly", 28, at(2027, 2, 28, 8)},  //
	} {
		if got := nextRun(tc.from, tc.freq, tc.day); !got.Equal(tc.want) {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}
