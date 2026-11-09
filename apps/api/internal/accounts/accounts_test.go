package accounts

import (
	"context"
	"errors"
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

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

// profiles is a Customers fake whose tier and duress state a test can change.
type profiles struct {
	mu sync.Mutex
	m  map[uuid.UUID]identity.CustomerProfile
}

func (p *profiles) CustomerProfile(_ context.Context, id uuid.UUID) (identity.CustomerProfile, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.m[id], nil
}

func (p *profiles) set(id uuid.UUID, f func(*identity.CustomerProfile)) {
	p.mu.Lock()
	defer p.mu.Unlock()
	prof := p.m[id]
	f(&prof)
	p.m[id] = prof
}

type fixture struct {
	t     *testing.T
	pool  *pgxpool.Pool
	svc   *Service
	profs *profiles
	n     atomic.Int32
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	pool := testdb.New(t)
	profs := &profiles{m: map[uuid.UUID]identity.CustomerProfile{}}
	svc, err := NewService(Config{Pool: pool, Customers: profs, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	return &fixture{t: t, pool: pool, svc: svc, profs: profs}
}

// customer inserts a user, opens their NGN account as sign-up does, and returns a
// context signed in as them.
func (f *fixture) customer() (context.Context, uuid.UUID) {
	f.t.Helper()
	id := uuid.New()
	n := f.n.Add(1)
	ctx := f.t.Context()
	if _, err := f.pool.Exec(ctx, `INSERT INTO users (id, first_name, last_name, email, phone, date_of_birth,
		password_hash, terms_version, privacy_version, consent_accepted_at)
		VALUES ($1, 'Tolu', 'Adeyemi', $2, $3, '1996-04-12', 'x', '2026-10', '2026-10', now())`,
		id, fmt.Sprintf("c%d@example.com", n), fmt.Sprintf("+2348031%06d", n)); err != nil {
		f.t.Fatal(err)
	}
	if err := pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		return OpenCurrentAccount(ctx, tx, identity.NewCustomer{UserID: id, Name: "Tolu Adeyemi"})
	}); err != nil {
		f.t.Fatal(err)
	}
	f.profs.set(id, func(p *identity.CustomerProfile) { *p = identity.CustomerProfile{Name: "Tolu Adeyemi", KycTier: 1} })
	return identity.WithPrincipal(ctx, identity.Principal{UserID: id}), id
}

// fund posts a demo deposit into the account with its transaction line, as Demo Controls will.
func (f *fixture) fund(user, account uuid.UUID, amount money.Money, narration string, at time.Time) {
	f.t.Helper()
	ctx := f.t.Context()
	err := pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		src, err := ledger.SystemAccount(ctx, tx, ledger.KindDemoFunding, string(amount.Currency()))
		if err != nil {
			return err
		}
		posted, err := ledger.Post(ctx, tx, ledger.Entry{
			Kind: "demo_funding", Reference: "demo", Legs: []ledger.Leg{ledger.Debit(src.ID, amount), ledger.Credit(account, amount)},
		})
		if err != nil {
			return err
		}
		_, err = Record(ctx, tx, Line{
			UserID: user, AccountID: account, Type: "deposit", Direction: "credit", Status: "completed", Amount: amount,
			Entry: &posted, Narration: narration, Reference: "NEM" + uuid.NewString()[:8], Category: "salary_income",
			Counterparty: api.Counterparty{Name: "Demo funding"}, At: at,
		})
		return err
	})
	if err != nil {
		f.t.Fatal(err)
	}
}

func ngn(minor int64) money.Money { return money.New(minor, money.NGN) }

func TestSignUpOpensAnNGNAccountWithAValidNuban(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	ctx, _ := f.customer()
	accs, err := f.svc.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(accs) != 1 {
		t.Fatalf("accounts = %d, want 1", len(accs))
	}
	a := accs[0]
	if a.Kind != KindCurrent || a.Currency != "NGN" || !ValidNuban(BankCode, a.AccountNumber) || a.Status != "active" {
		t.Fatalf("account = %+v", a.CustomerAccount)
	}
	if !a.Ledger.IsZero() || !a.Available.IsZero() || a.MaxBalance == nil || a.MaxBalance.Amount() != 30_000_000 {
		t.Fatalf("balances = %v / %v, cap %v", a.Ledger, a.Available, a.MaxBalance)
	}
	if a.AccountName != "Tolu Adeyemi" {
		t.Fatalf("name = %q", a.AccountName)
	}
	// Each customer gets their own number.
	ctx2, _ := f.customer()
	b, err := f.svc.List(ctx2)
	if err != nil || b[0].AccountNumber == a.AccountNumber {
		t.Fatalf("second customer number %v, %v", b, err)
	}
}

func TestWalletsNeedTierTwoAndOpenOnce(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	ctx, user := f.customer()
	if _, err := f.svc.OpenWallet(ctx, money.USD); !errors.Is(err, ErrKycTierRequired) {
		t.Fatalf("tier 1 wallet: %v", err)
	}
	f.profs.set(user, func(p *identity.CustomerProfile) { p.KycTier = 2 })
	usd, err := f.svc.OpenWallet(ctx, money.USD)
	if err != nil {
		t.Fatal(err)
	}
	if usd.Kind != KindWallet || usd.Currency != "USD" || usd.MaxBalance != nil || usd.AccountNumber[:2] != walletPrefix {
		t.Fatalf("wallet = %+v", usd.CustomerAccount)
	}
	if _, err := f.svc.OpenWallet(ctx, money.USD); !errors.Is(err, errAccountExists) {
		t.Fatalf("second USD wallet: %v", err)
	}
	if _, err := f.svc.OpenWallet(ctx, money.EUR); err != nil {
		t.Fatal(err)
	}
	accs, err := f.svc.List(ctx)
	if err != nil || len(accs) != 3 || accs[0].Currency != "NGN" || accs[1].Currency != "USD" || accs[2].Currency != "EUR" {
		t.Fatalf("accounts = %+v, %v", accs, err)
	}
	// The contract's receiving details for each scheme validate as their schemes.
	for _, v := range accs {
		d, err := receiving(v)
		if err != nil {
			t.Fatal(err)
		}
		if v.Currency == "EUR" {
			iban, err := d.AsIbanDetails()
			if err != nil || !validIBAN(iban.Iban) {
				t.Fatalf("EUR details = %+v, %v", iban, err)
			}
		}
	}
}

func TestBalancesHoldsAndAnotherCustomersAccount(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	ctx, user := f.customer()
	accs, err := f.svc.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	acct := accs[0].AccountID
	f.fund(user, acct, ngn(5_000_000), "Salary", time.Now())
	if err := pgx.BeginFunc(t.Context(), f.pool, func(tx pgx.Tx) error {
		_, err := ledger.PlaceHold(t.Context(), tx, ledger.Hold{Account: acct, Amount: ngn(120_000), Reference: "card_auth", Reason: "card_authorization"})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	got, err := f.svc.Get(ctx, acct)
	if err != nil || got.Ledger.Amount() != 5_000_000 || got.Available.Amount() != 4_880_000 {
		t.Fatalf("balances = %v / %v, %v", got.Ledger, got.Available, err)
	}
	holds, total, err := f.svc.Holds(ctx, acct)
	if err != nil || len(holds) != 1 || total.Amount() != 120_000 || holds[0].Reason != "card_authorization" {
		t.Fatalf("holds = %+v total %v, %v", holds, total, err)
	}

	other, _ := f.customer()
	if _, err := f.svc.Get(other, acct); !errors.Is(err, ErrAccountNotFound) {
		t.Fatalf("other customer's account: %v", err)
	}
	if _, _, err := f.svc.Holds(other, acct); !errors.Is(err, ErrAccountNotFound) {
		t.Fatalf("other customer's holds: %v", err)
	}
}

func TestHistoryFiltersSearchesAndPages(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	ctx, user := f.customer()
	f.profs.set(user, func(p *identity.CustomerProfile) { p.KycTier = 2 })
	accs, err := f.svc.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	acct := accs[0].AccountID
	usd, err := f.svc.OpenWallet(ctx, money.USD)
	if err != nil {
		t.Fatal(err)
	}
	// day3 is 23:30 on the 3rd in Lagos; day4 is 00:30 on the 4th in Lagos but still the
	// 3rd in UTC, so a UTC date filter would put it on the wrong day.
	day3 := time.Date(2026, 11, 3, 22, 30, 0, 0, time.UTC)
	day4 := time.Date(2026, 11, 3, 23, 30, 0, 0, time.UTC)
	f.fund(user, acct, ngn(5_000_000), "Salary for October", day3)
	f.fund(user, acct, ngn(250_000), "Refund 100% back_to_you", day4)
	f.fund(user, usd.AccountID, money.New(10_000, money.USD), "Upwork payout", day4.Add(time.Hour))

	list := func(fl Filter) []string {
		t.Helper()
		rows, _, err := f.svc.Transactions(ctx, fl)
		if err != nil {
			t.Fatal(err)
		}
		out := make([]string, 0, len(rows))
		for _, r := range rows {
			out = append(out, r.Narration)
		}
		return out
	}
	str := func(s string) *string { return &s }
	if got := list(Filter{}); len(got) != 3 || got[0] != "Upwork payout" {
		t.Fatalf("all = %v (newest first)", got)
	}
	if got := list(Filter{Currency: str("NGN")}); len(got) != 2 {
		t.Fatalf("NGN = %v", got)
	}
	if got := list(Filter{AccountID: &usd.AccountID}); len(got) != 1 {
		t.Fatalf("USD account = %v", got)
	}
	if got := list(Filter{Types: []string{"transfer_out"}}); len(got) != 0 {
		t.Fatalf("transfer_out = %v", got)
	}
	// % and _ are matched literally, not as wildcards.
	if got := list(Filter{Query: "100%"}); len(got) != 1 || got[0] != "Refund 100% back_to_you" {
		t.Fatalf("q=100%% = %v", got)
	}
	if got := list(Filter{Query: "0%"}); len(got) != 1 {
		t.Fatalf("q=0%% = %v", got)
	}
	if got := list(Filter{Query: "demo FUNDING"}); len(got) != 3 {
		t.Fatalf("counterparty search = %v", got)
	}
	// Lagos days: the 3rd holds only the salary; the 4th holds the refund and payout.
	d3 := time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC)
	d4 := d3.AddDate(0, 0, 1)
	if got := list(Filter{From: &d3, To: &d3}); len(got) != 1 || got[0] != "Salary for October" {
		t.Fatalf("on the 3rd = %v", got)
	}
	if got := list(Filter{From: &d4}); len(got) != 2 {
		t.Fatalf("from the 4th = %v", got)
	}

	// Pages of one walk the whole list with no repeats.
	one := 1
	var seen []string
	var cursor *string
	for range 5 {
		rows, page, err := f.svc.Transactions(ctx, Filter{Limit: &one, Cursor: cursor})
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range rows {
			seen = append(seen, r.Narration)
		}
		if page.NextCursor == nil {
			break
		}
		cursor = page.NextCursor
	}
	if len(seen) != 3 || seen[0] != "Upwork payout" || seen[2] != "Salary for October" {
		t.Fatalf("paged = %v", seen)
	}

	// Detail: a credit cannot be disputed; the balance after is the ledger's.
	rows, _, err := f.svc.Transactions(ctx, Filter{Query: "Refund"})
	if err != nil {
		t.Fatal(err)
	}
	d, err := f.svc.Transaction(ctx, rows[0].ID)
	if err != nil || d.CanDispute || d.CanRepeat || *d.BalanceAfterMinor != 5_250_000 || len(d.Timeline) != 1 || d.Timeline[0].Label != "Completed" {
		t.Fatalf("detail = %+v, %v", d, err)
	}
	other, _ := f.customer()
	if _, err := f.svc.Transaction(other, rows[0].ID); !errors.Is(err, ErrTransactionNotFound) {
		t.Fatalf("other customer's transaction: %v", err)
	}
	if got, _, err := f.svc.Transactions(other, Filter{}); err != nil || len(got) != 0 {
		t.Fatalf("other customer's history = %v, %v", got, err)
	}
}

func TestDuressShowsTheDecoy(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	ctx, user := f.customer()
	f.profs.set(user, func(p *identity.CustomerProfile) { p.KycTier = 2 })
	accs, err := f.svc.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	acct := accs[0].AccountID
	usd, err := f.svc.OpenWallet(ctx, money.USD)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	f.fund(user, acct, ngn(5_000_000), "Salary", now)
	f.fund(user, acct, ngn(500_000), "Small gift", now.Add(time.Second))
	f.fund(user, usd.AccountID, money.New(10_000, money.USD), "Payout", now.Add(2*time.Second))

	f.profs.set(user, func(p *identity.CustomerProfile) { p.InDuress = true })
	accs, err = f.svc.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if accs[0].Ledger.Amount() != decoyNGNBalance.Amount() || !accs[1].Ledger.IsZero() || !accs[1].Available.IsZero() {
		t.Fatalf("decoy balances = %v, %v", accs[0].Ledger, accs[1].Ledger)
	}
	rows, _, err := f.svc.Transactions(ctx, Filter{})
	if err != nil || len(rows) != 1 || rows[0].Narration != "Small gift" || rows[0].BalanceAfterMinor != nil {
		t.Fatalf("decoy history = %+v, %v", rows, err)
	}
	usdCode := "USD"
	if rows, _, err := f.svc.Transactions(ctx, Filter{Currency: &usdCode}); err != nil || len(rows) != 0 {
		t.Fatalf("decoy USD history = %+v, %v", rows, err)
	}
}
