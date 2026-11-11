package cards

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

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/cards/cardsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/fx"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/fieldcrypt"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

// profiles is the customers' KYC tiers, settable per test.
type profiles struct {
	mu sync.Mutex
	m  map[uuid.UUID]identity.CustomerProfile
}

func (p *profiles) CustomerProfile(_ context.Context, id uuid.UUID) (identity.CustomerProfile, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.m[id], nil
}

func (p *profiles) setTier(id uuid.UUID, tier int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.m[id] = identity.CustomerProfile{Name: "Tolu Adeyemi", KycTier: tier}
}

// stepUps accepts the token "good" once per purpose and refuses anything else, like the
// real thing: single use, bound to a purpose.
type stepUps struct {
	mu    sync.Mutex
	spent map[string]bool
}

var errStepUp = problem.New(403, "step_up_required", "Confirm it is you first")

func (s *stepUps) ConsumeStepUp(_ context.Context, _ pgx.Tx, _ uuid.UUID, purpose, token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := purpose + ":" + token
	if token == "" || token != "good" || s.spent[key] {
		return errStepUp
	}
	s.spent[key] = true
	return nil
}

// reset makes the token usable again, standing in for a fresh step-up.
func (s *stepUps) reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.spent = map[string]bool{}
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

type fixture struct {
	t     *testing.T
	pool  *pgxpool.Pool
	clk   *clock
	svc   *Service
	accts *accounts.Service
	profs *profiles
	steps *stepUps
	ring  *fieldcrypt.Keyring
	n     atomic.Int64
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	pool := testdb.New(t)
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	f := &fixture{
		t: t, pool: pool, clk: &clock{t: time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)},
		profs: &profiles{m: map[uuid.UUID]identity.CustomerProfile{}}, steps: &stepUps{spent: map[string]bool{}},
	}
	var err error
	if f.accts, err = accounts.NewService(accounts.Config{Pool: pool, Customers: f.profs, Logger: quiet}); err != nil {
		t.Fatal(err)
	}
	key := func(b byte) []byte {
		k := make([]byte, fieldcrypt.KeySize)
		for i := range k {
			k[i] = b
		}
		return k
	}
	if f.ring, err = fieldcrypt.New(map[uint16][]byte{1: key(7)}, key(9)); err != nil {
		t.Fatal(err)
	}
	if f.svc, err = NewService(Config{
		Pool: pool, Accounts: f.accts, Customers: f.profs, StepUps: f.steps, Keyring: f.ring, Rates: rates{}, Logger: quiet, Now: f.clk.Now,
	}); err != nil {
		t.Fatal(err)
	}
	return f
}

type customer struct {
	ctx context.Context
	id  uuid.UUID
	ngn uuid.UUID
	usd uuid.UUID
	gbp uuid.UUID
}

// customer signs up a Tier 2 customer with an NGN account (funded) and USD and GBP wallets.
func (f *fixture) customer(ngnKobo, usdCents int64) customer {
	f.t.Helper()
	ctx := f.t.Context()
	id := uuid.New()
	n := f.n.Add(1)
	if _, err := f.pool.Exec(ctx, `INSERT INTO users (id, first_name, last_name, email, phone, date_of_birth,
		password_hash, terms_version, privacy_version, consent_accepted_at)
		VALUES ($1, 'Tolu', 'Adeyemi', $2, $3, '1996-04-12', 'x', '2026-10', '2026-10', now())`,
		id, fmt.Sprintf("card%d@example.com", n), fmt.Sprintf("+2348033%06d", n)); err != nil {
		f.t.Fatal(err)
	}
	if err := pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		return accounts.OpenCurrentAccount(ctx, tx, identity.NewCustomer{UserID: id, Name: "Tolu Adeyemi"})
	}); err != nil {
		f.t.Fatal(err)
	}
	f.profs.setTier(id, 2)
	c := customer{ctx: identity.WithPrincipal(ctx, identity.Principal{UserID: id}), id: id}
	usd, err := f.accts.OpenWallet(c.ctx, money.USD)
	if err != nil {
		f.t.Fatal(err)
	}
	gbp, err := f.accts.OpenWallet(c.ctx, money.GBP)
	if err != nil {
		f.t.Fatal(err)
	}
	list, err := f.accts.List(c.ctx)
	if err != nil {
		f.t.Fatal(err)
	}
	c.ngn, c.usd, c.gbp = list[0].AccountID, usd.AccountID, gbp.AccountID
	f.fund(c.ngn, money.NGN, ngnKobo)
	f.fund(c.usd, money.USD, usdCents)
	return c
}

func (f *fixture) fund(account uuid.UUID, cur money.Currency, minor int64) {
	f.t.Helper()
	if minor == 0 {
		return
	}
	if err := pgx.BeginFunc(f.t.Context(), f.pool, func(tx pgx.Tx) error {
		src, err := ledger.SystemAccount(f.t.Context(), tx, ledger.KindDemoFunding, string(cur))
		if err != nil {
			return err
		}
		amt := money.New(minor, cur)
		_, err = ledger.Post(f.t.Context(), tx, ledger.Entry{Kind: "demo_funding", Reference: "seed",
			Legs: []ledger.Leg{ledger.Debit(src.ID, amt), ledger.Credit(account, amt)}})
		return err
	}); err != nil {
		f.t.Fatal(err)
	}
}

func wantProblem(t *testing.T, err error, code string) {
	t.Helper()
	var p *problem.Error
	if err == nil || !errors.As(err, &p) || p.Code != code {
		t.Fatalf("err = %v, want problem %q", err, code)
	}
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// rates is a fixed rate card: USD-NGN 1600 mid (1576 buy, 1624 sell) and GBP-NGN 2000 mid
// (1970 buy, 2030 sell).
type rates struct{}

func (rates) Rates(context.Context) ([]fx.RateView, error) {
	r := func(s string) fx.Rate {
		v, err := fx.ParseRate(s)
		if err != nil {
			panic(err)
		}
		return v
	}
	return []fx.RateView{
		{Pair: "USD-NGN", Base: money.USD, Quote: money.NGN, Mid: r("1600"), Buy: r("1576"), Sell: r("1624"), SpreadBPS: 150},
		{Pair: "GBP-NGN", Base: money.GBP, Quote: money.NGN, Mid: r("2000"), Buy: r("1970"), Sell: r("2030"), SpreadBPS: 150},
	}, nil
}

// issued is a card with the details a merchant would be given.
type issued struct {
	card cardsdb.Card
	pan  string
	cvv  string
}

// issue creates a card and reveals its details, as the app would before a purchase.
func (f *fixture) issue(c customer, req IssueRequest) issued {
	f.t.Helper()
	card, err := f.svc.Issue(c.ctx, req)
	if err != nil {
		f.t.Fatal(err)
	}
	f.steps.reset()
	s, err := f.svc.Reveal(c.ctx, card.ID, "good")
	if err != nil {
		f.t.Fatal(err)
	}
	return issued{card: card, pan: s.PAN, cvv: s.CVV}
}

// charge is a request a merchant would send for this card.
func (i issued) charge(amount money.Money, channel string) ChargeRequest {
	return ChargeRequest{
		PAN: i.pan, CVV: i.cvv, Month: int(i.card.ExpiryMonth), Year: int(i.card.ExpiryYear), Amount: amount, Channel: channel,
		Merchant: Merchant{ID: "m_chicken", Name: "Chicken Republic", MCC: "5812", Country: "NG"},
	}
}

func (f *fixture) available(account uuid.UUID) (ledgerBal, avail int64) {
	f.t.Helper()
	b, err := ledger.GetBalances(f.t.Context(), f.pool, account)
	if err != nil {
		f.t.Fatal(err)
	}
	return b.Ledger.Amount(), b.Available.Amount()
}

func naira(n int64) money.Money { return money.New(n*100, money.NGN) }
