package ajo

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

type mockCustomers struct {
	mu     sync.Mutex
	users  map[uuid.UUID]identity.CustomerProfile
	byName map[string]uuid.UUID
}

func newMockCustomers() *mockCustomers {
	return &mockCustomers{
		users:  make(map[uuid.UUID]identity.CustomerProfile),
		byName: make(map[string]uuid.UUID),
	}
}

func (m *mockCustomers) add(id uuid.UUID, name, nemtag string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p := identity.CustomerProfile{Name: name, Nemtag: &nemtag, KycTier: 2}
	m.users[id] = p
	m.byName[nemtag] = id
	m.byName["@"+nemtag] = id
}

func (m *mockCustomers) CustomerProfile(_ context.Context, userID uuid.UUID) (identity.CustomerProfile, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if p, ok := m.users[userID]; ok {
		return p, nil
	}
	return identity.CustomerProfile{Name: "Test Member", KycTier: 2}, nil
}

func (m *mockCustomers) FindCustomer(_ context.Context, handle string) (uuid.UUID, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if id, ok := m.byName[handle]; ok {
		return id, nil
	}
	return uuid.Nil, fmt.Errorf("user not found: %s", handle)
}

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

type fixture struct {
	t    *testing.T
	pool *pgxpool.Pool
	svc  *Service
	cust *mockCustomers
	clk  *clock
	n    atomic.Int64
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	pool := testdb.New(t)
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	cust := newMockCustomers()
	clk := &clock{t: time.Date(2026, 11, 11, 9, 0, 0, 0, time.UTC)}
	accts, err := accounts.NewService(accounts.Config{Pool: pool, Customers: cust, Logger: quiet})
	if err != nil {
		t.Fatal(err)
	}
	svc, err := NewService(Config{
		Pool:      pool,
		Accounts:  accts,
		Customers: cust,
		Logger:    quiet,
		Now:       clk.Now,
	})
	if err != nil {
		t.Fatal(err)
	}
	return &fixture{t: t, pool: pool, svc: svc, cust: cust, clk: clk}
}

type testUser struct {
	ctx  context.Context
	id   uuid.UUID
	ngn  uuid.UUID
	name string
	tag  string
}

func (f *fixture) user(name, tag string, balanceKobo int64) testUser {
	f.t.Helper()
	ctx := f.t.Context()
	id := uuid.New()
	n := f.n.Add(1)
	if _, err := f.pool.Exec(ctx, `INSERT INTO users (id, first_name, last_name, email, phone, nemtag, date_of_birth,
		password_hash, terms_version, privacy_version, consent_accepted_at)
		VALUES ($1, $2, 'User', $3, $4, $5, '1996-04-12', 'x', '2026-10', '2026-10', now())`,
		id, name, fmt.Sprintf("ajo%d@example.com", n), fmt.Sprintf("+2348077%06d", n), tag); err != nil {
		f.t.Fatal(err)
	}
	if err := pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		return accounts.OpenCurrentAccount(ctx, tx, identity.NewCustomer{UserID: id, Name: name})
	}); err != nil {
		f.t.Fatal(err)
	}
	f.cust.add(id, name, tag)
	u := testUser{
		ctx:  identity.WithPrincipal(ctx, identity.Principal{UserID: id}),
		id:   id,
		name: name,
		tag:  tag,
	}
	if err := f.pool.QueryRow(ctx, `SELECT account_id FROM customer_accounts WHERE user_id = $1 AND currency = 'NGN'`, id).Scan(&u.ngn); err != nil {
		f.t.Fatal(err)
	}
	if balanceKobo > 0 {
		f.fund(u.ngn, balanceKobo)
	}
	return u
}

func (f *fixture) fund(accountID uuid.UUID, kobo int64) {
	f.t.Helper()
	ctx := f.t.Context()
	if err := pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		src, err := ledger.SystemAccount(ctx, tx, ledger.KindDemoFunding, "NGN")
		if err != nil {
			return err
		}
		amt := money.New(kobo, money.NGN)
		_, err = ledger.Post(ctx, tx, ledger.Entry{
			Kind: "demo_funding", Reference: "seed",
			Legs: []ledger.Leg{ledger.Debit(src.ID, amt), ledger.Credit(accountID, amt)},
		})
		return err
	}); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) balance(accountID uuid.UUID) int64 {
	f.t.Helper()
	var bal int64
	if err := f.pool.QueryRow(f.t.Context(), `SELECT balance_minor FROM ledger_accounts WHERE id = $1`, accountID).Scan(&bal); err != nil {
		f.t.Fatal(err)
	}
	return bal
}

func TestAjoGroupCreationAndTerms(t *testing.T) {
	f := newFixture(t)
	u := f.user("Tolu", "tolu", 100_000_00)

	// Create group
	grp, err := f.svc.Create(u.ctx, CreateGroupInput{
		Name:             "Family Ajo",
		Contribution:     money.New(10_000_00, money.NGN),
		Frequency:        "monthly",
		MemberCount:      3,
		Rotation:         "fixed",
		StartDate:        f.clk.Now(),
		GracePeriodHours: 24,
		SourceAccountID:  u.ngn,
	})
	if err != nil {
		t.Fatalf("create ajo group: %v", err)
	}

	if grp.Name != "Family Ajo" || grp.Status != "forming" {
		t.Fatalf("unexpected group: %+v", grp)
	}
	if len(grp.Members) != 1 || grp.Members[0].UserID != u.id {
		t.Fatalf("unexpected members: %+v", grp.Members)
	}
	if grp.PotBalance.Amount() != 0 {
		t.Fatalf("pot balance should be zero, got %d", grp.PotBalance.Amount())
	}
}

func TestAjoInvitesAndAccept(t *testing.T) {
	f := newFixture(t)
	u1 := f.user("Tolu", "tolu", 100_000_00)
	u2 := f.user("Emeka", "emeka", 100_000_00)
	u3 := f.user("Amina", "amina", 100_000_00)

	grp, err := f.svc.Create(u1.ctx, CreateGroupInput{
		Name:             "Savings Circle",
		Contribution:     money.New(5_000_00, money.NGN),
		Frequency:        "weekly",
		MemberCount:      3,
		Rotation:         "fixed",
		StartDate:        f.clk.Now(),
		GracePeriodHours: 24,
		SourceAccountID:  u1.ngn,
	})
	if err != nil {
		t.Fatal(err)
	}

	// Invite u2
	inv, err := f.svc.Invite(u1.ctx, grp.ID, []string{"@" + u2.tag})
	if err != nil {
		t.Fatalf("invite: %v", err)
	}
	if inv.InviteCode != grp.InviteCode {
		t.Fatalf("unexpected invite code: %s", inv.InviteCode)
	}

	// u3 accepts via invite code
	accepted, err := f.svc.AcceptInvite(u3.ctx, grp.InviteCode, u3.ngn)
	if err != nil {
		t.Fatalf("accept invite: %v", err)
	}
	if len(accepted.Members) != 3 {
		t.Fatalf("expected 3 members, got %d", len(accepted.Members))
	}
}

func TestAjoStartAndCycleAutoDebits(t *testing.T) {
	f := newFixture(t)
	u1 := f.user("Tolu", "tolu", 50_000_00)
	u2 := f.user("Emeka", "emeka", 50_000_00)

	grp, err := f.svc.Create(u1.ctx, CreateGroupInput{
		Name:             "Duo Ajo",
		Contribution:     money.New(10_000_00, money.NGN),
		Frequency:        "daily",
		MemberCount:      2,
		Rotation:         "fixed",
		StartDate:        f.clk.Now(),
		GracePeriodHours: 24,
		SourceAccountID:  u1.ngn,
	})
	if err != nil {
		t.Fatal(err)
	}

	_, err = f.svc.AcceptInvite(u2.ctx, grp.InviteCode, u2.ngn)
	if err != nil {
		t.Fatal(err)
	}

	// Start group
	started, err := f.svc.Start(u1.ctx, grp.ID)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if started.Status != "active" || started.CurrentCycle != 1 {
		t.Fatalf("unexpected started group: %+v", started)
	}

	// Both members were auto-debited for cycle 1 (2 * 10,000 = 20,000 pot)
	if bal := f.balance(grp.AccountID); bal != 20_000_00 {
		t.Fatalf("escrow pot balance = %d, want 2000000", bal)
	}
	if bal := f.balance(u1.ngn); bal != 40_000_00 {
		t.Fatalf("u1 balance = %d, want 4000000", bal)
	}
	if bal := f.balance(u2.ngn); bal != 40_000_00 {
		t.Fatalf("u2 balance = %d, want 4000000", bal)
	}

	// Payout cycle 1 to u1 (position 1)
	f.svc.payoutCycle(f.t.Context(), grp.ID, 1)

	// Escrow emptied, u1 received 20,000 pot
	if bal := f.balance(grp.AccountID); bal != 0 {
		t.Fatalf("escrow after payout = %d, want 0", bal)
	}
	if bal := f.balance(u1.ngn); bal != 60_000_00 {
		t.Fatalf("u1 after payout = %d, want 6000000", bal)
	}
}

func TestAjoLeaveForming(t *testing.T) {
	f := newFixture(t)
	u1 := f.user("Tolu", "tolu", 50_000_00)
	u2 := f.user("Emeka", "emeka", 50_000_00)

	grp, err := f.svc.Create(u1.ctx, CreateGroupInput{
		Name:             "Leave Test",
		Contribution:     money.New(10_000_00, money.NGN),
		Frequency:        "weekly",
		MemberCount:      3,
		Rotation:         "fixed",
		StartDate:        f.clk.Now(),
		GracePeriodHours: 24,
		SourceAccountID:  u1.ngn,
	})
	if err != nil {
		t.Fatal(err)
	}

	_, _ = f.svc.AcceptInvite(u2.ctx, grp.InviteCode, u2.ngn)
	if err := f.svc.Leave(u2.ctx, grp.ID); err != nil {
		t.Fatalf("u2 leave: %v", err)
	}

	after, err := f.svc.Get(u1.ctx, grp.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(after.Members) != 1 {
		t.Fatalf("expected 1 member after leave, got %d", len(after.Members))
	}
}

func TestCycleDaysAndDueDates(t *testing.T) {
	if got := cycleDays("daily"); got != 1 {
		t.Errorf("daily cycle days = %d, want 1", got)
	}
	if got := cycleDays("weekly"); got != 7 {
		t.Errorf("weekly cycle days = %d, want 7", got)
	}
	if got := cycleDays("monthly"); got != 30 {
		t.Errorf("monthly cycle days = %d, want 30", got)
	}
	if got := cycleDays("other"); got != 7 {
		t.Errorf("default cycle days = %d, want 7", got)
	}

	start := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	day := lagosDay(start)
	if day.Hour() != 0 || day.Minute() != 0 || day.Second() != 0 {
		t.Errorf("lagosDay not midnight: %v", day)
	}
}
