// Package accounts is what a customer sees of their money (FR-ACC): the NGN current
// account and foreign-currency wallets with their receiving details and balances, the
// holds behind "available", and the transaction history.
//
// Balances live in the ledger and only move through its posting engine; this package
// reads them and keeps the customer-facing records around them. Other domains write a
// transaction line with Record in the same database transaction as the entry it
// describes, so the history can never disagree with the ledger.
package accounts

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts/accountsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/ledgerdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// Account kinds (contract AccountKind) and the ledger kinds behind them.
const (
	KindCurrent = "ngn_current"
	KindWallet  = "fx_wallet"

	ledgerCurrent = "customer_current"
	ledgerWallet  = "customer_wallet"
)

// Problems, with the codes and wording of the mock bank (apps/mobile/src/data/mock).
var (
	ErrAccountNotFound = problem.NotFound("Account")
	ErrKycTierRequired = problem.New(http.StatusForbidden, "kyc_tier_required", "Foreign-currency wallets needs KYC Tier 2").
				WithDetail("Verify your identity in Profile → Verification to unlock it.")
	errAccountExists = problem.New(http.StatusConflict, "account_exists", "You already have this wallet")
)

// walletTier is the KYC tier foreign-currency wallets need (KYC-7).
const walletTier = 2

// Duress decoy (SEC-5), as the mock bank's domains/duress.ts: a small naira balance,
// empty wallets, and only small naira activity.
var (
	decoyNGNBalance     = money.New(385_000, money.NGN)   // ₦3,850
	decoyMaxTransaction = money.New(1_000_000, money.NGN) // ₦10,000
)

// tierCaps is the NGN balance cap per KYC tier (@nem/shared KYC_TIERS); tier 3 is uncapped.
var tierCaps = map[int]money.Money{1: money.New(30_000_000, money.NGN), 2: money.New(50_000_000, money.NGN)}

// Customers tells accounts who a customer is. identity.Service implements it.
type Customers interface {
	CustomerProfile(ctx context.Context, userID uuid.UUID) (identity.CustomerProfile, error)
}

// Config holds the service's dependencies.
type Config struct {
	Pool      *pgxpool.Pool
	Customers Customers
	Logger    *slog.Logger
	// Now defaults to time.Now.
	Now func() time.Time
	// VerifyURL prefixes a statement's verification code in its QR link; empty means
	// DefaultVerifyURL.
	VerifyURL string
	// Timelines returns a transfer's status history for its transactions' detail (the
	// transfers domain); nil gives every line a single step for its status.
	Timelines func(ctx context.Context, transferID uuid.UUID) ([]api.TimelineEvent, error)
}

// Service implements the accounts use cases.
type Service struct {
	pool      *pgxpool.Pool
	q         *accountsdb.Queries
	customers Customers
	log       *slog.Logger
	now       func() time.Time
	timelines func(ctx context.Context, transferID uuid.UUID) ([]api.TimelineEvent, error)
	verifyURL string
}

// NewService checks the configuration and returns the service.
func NewService(cfg Config) (*Service, error) {
	if cfg.Pool == nil || cfg.Customers == nil || cfg.Logger == nil {
		return nil, errors.New("accounts: pool, customers and logger are required")
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.VerifyURL == "" {
		cfg.VerifyURL = DefaultVerifyURL
	}
	return &Service{verifyURL: cfg.VerifyURL, pool: cfg.Pool, q: accountsdb.New(cfg.Pool), customers: cfg.Customers, log: cfg.Logger, now: cfg.Now, timelines: cfg.Timelines}, nil
}

// View is an account as the customer sees it.
type View struct {
	accountsdb.CustomerAccount
	Ledger, Available money.Money
	// MaxBalance is the KYC cap, or nil when there is none.
	MaxBalance *money.Money
	// AccountName is the name payers see.
	AccountName string
}

// OpenCurrentAccount opens a new customer's NGN account with a fresh NUBAN, inside the
// sign-up transaction (identity.Config.OnCustomerCreated).
func OpenCurrentAccount(ctx context.Context, tx pgx.Tx, c identity.NewCustomer) error {
	q := accountsdb.New(tx)
	serial, err := q.NextNubanSerial(ctx)
	if err != nil {
		return fmt.Errorf("nuban serial: %w", err)
	}
	number, err := nubanFor(serial)
	if err != nil {
		return err
	}
	_, err = open(ctx, q, c.UserID, money.NGN, number)
	return err
}

// open writes the ledger account and its customer record together.
func open(ctx context.Context, q *accountsdb.Queries, userID uuid.UUID, currency money.Currency, number string) (accountsdb.CustomerAccount, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return accountsdb.CustomerAccount{}, fmt.Errorf("account id: %w", err)
	}
	kind, lkind, name := KindWallet, ledgerWallet, string(currency)+" wallet"
	if currency == money.NGN {
		kind, lkind, name = KindCurrent, ledgerCurrent, "NGN current account"
	}
	// The ledger name is a label for the console, not the customer's name: no PII there.
	if err := q.InsertLedgerAccount(ctx, accountsdb.InsertLedgerAccountParams{
		ID: id, OwnerID: &userID, Kind: lkind, Currency: string(currency), Name: name,
	}); err != nil {
		if isUnique(err) {
			return accountsdb.CustomerAccount{}, errAccountExists
		}
		return accountsdb.CustomerAccount{}, fmt.Errorf("insert ledger account: %w", err)
	}
	acc, err := q.InsertCustomerAccount(ctx, accountsdb.InsertCustomerAccountParams{
		AccountID: id, UserID: userID, Currency: string(currency), Kind: kind, AccountNumber: number,
	})
	if err != nil {
		if isUnique(err) {
			return accountsdb.CustomerAccount{}, errAccountExists
		}
		return accountsdb.CustomerAccount{}, fmt.Errorf("insert account: %w", err)
	}
	return acc, nil
}

// OpenWallet opens a USD, GBP or EUR wallet for the caller (KYC Tier 2+).
func (s *Service) OpenWallet(ctx context.Context, currency money.Currency) (View, error) {
	p, prof, err := s.caller(ctx)
	if err != nil {
		return View{}, err
	}
	if prof.KycTier < walletTier {
		return View{}, ErrKycTierRequired
	}
	if _, err := s.q.GetCustomerAccountByCurrency(ctx, accountsdb.GetCustomerAccountByCurrencyParams{
		UserID: p.UserID, Currency: string(currency),
	}); err == nil {
		return View{}, walletExists(currency)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return View{}, fmt.Errorf("load wallet: %w", err)
	}
	var acc accountsdb.CustomerAccount
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		serial, err := q.NextWalletSerial(ctx)
		if err != nil {
			return fmt.Errorf("wallet serial: %w", err)
		}
		acc, err = open(ctx, q, p.UserID, currency, walletNumberFor(serial))
		return err
	})
	if errors.Is(err, errAccountExists) {
		// A second request for the same wallet won the race.
		return View{}, walletExists(currency)
	}
	if err != nil {
		return View{}, err
	}
	// A new wallet is empty: no need to read the balances back.
	zero := money.Zero(currency)
	return s.view(acc, zero, zero, prof), nil
}

func walletExists(c money.Currency) error {
	return errAccountExists.WithDetailf("You already have a %s wallet", c)
}

// List returns the caller's accounts, NGN first.
func (s *Service) List(ctx context.Context) ([]View, error) {
	p, prof, err := s.caller(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListCustomerAccounts(ctx, p.UserID)
	if err != nil {
		return nil, fmt.Errorf("list accounts: %w", err)
	}
	out := make([]View, 0, len(rows))
	for _, r := range rows {
		c := money.Currency(r.Currency)
		out = append(out, s.view(accountsdb.CustomerAccount{
			AccountID: r.AccountID, UserID: r.UserID, Currency: r.Currency, Kind: r.Kind, AccountNumber: r.AccountNumber,
			Nickname: r.Nickname, Status: r.Status, OpenedAt: r.OpenedAt,
		}, money.New(r.BalanceMinor, c), money.New(r.AvailableMinor, c), prof))
	}
	return out, nil
}

// Get returns one of the caller's accounts; another customer's is "not found".
func (s *Service) Get(ctx context.Context, id uuid.UUID) (View, error) {
	p, prof, err := s.caller(ctx)
	if err != nil {
		return View{}, err
	}
	r, err := s.own(ctx, p.UserID, id)
	if err != nil {
		return View{}, err
	}
	c := money.Currency(r.Currency)
	return s.view(accountsdb.CustomerAccount{
		AccountID: r.AccountID, UserID: r.UserID, Currency: r.Currency, Kind: r.Kind, AccountNumber: r.AccountNumber,
		Nickname: r.Nickname, Status: r.Status, OpenedAt: r.OpenedAt,
	}, money.New(r.BalanceMinor, c), money.New(r.AvailableMinor, c), prof), nil
}

// Holds lists an account's active holds, newest first, with their total.
func (s *Service) Holds(ctx context.Context, id uuid.UUID) ([]ledgerdb.AccountHold, money.Money, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, money.Money{}, err
	}
	r, err := s.own(ctx, p.UserID, id)
	if err != nil {
		return nil, money.Money{}, err
	}
	holds, err := ledger.ActiveHolds(ctx, s.pool, id)
	if err != nil {
		return nil, money.Money{}, err
	}
	total := money.Zero(money.Currency(r.Currency))
	for _, h := range holds {
		if total, err = total.Add(money.New(h.AmountMinor, total.Currency())); err != nil {
			return nil, money.Money{}, fmt.Errorf("sum holds: %w", err)
		}
	}
	return holds, total, nil
}

func (s *Service) own(ctx context.Context, userID, id uuid.UUID) (accountsdb.GetCustomerAccountRow, error) {
	r, err := s.q.GetCustomerAccount(ctx, accountsdb.GetCustomerAccountParams{AccountID: id, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return accountsdb.GetCustomerAccountRow{}, ErrAccountNotFound
	}
	if err != nil {
		return accountsdb.GetCustomerAccountRow{}, fmt.Errorf("load account: %w", err)
	}
	return r, nil
}

func (s *Service) view(a accountsdb.CustomerAccount, bal, avail money.Money, prof identity.CustomerProfile) View {
	if prof.InDuress {
		bal, avail = decoy(bal), decoy(avail)
	}
	v := View{CustomerAccount: a, Ledger: bal, Available: avail, AccountName: prof.Name}
	if c, ok := tierCaps[prof.KycTier]; ok && c.Currency() == bal.Currency() {
		v.MaxBalance = &c
	}
	return v
}

// decoy is what the duress view shows for a balance: at most the decoy naira amount, and
// nothing in foreign wallets.
func decoy(m money.Money) money.Money {
	if m.Currency() != money.NGN {
		return money.Zero(m.Currency())
	}
	if m.Amount() < decoyNGNBalance.Amount() { // both NGN
		return m
	}
	return decoyNGNBalance
}

func (s *Service) caller(ctx context.Context) (identity.Principal, identity.CustomerProfile, error) {
	p, err := principal(ctx)
	if err != nil {
		return identity.Principal{}, identity.CustomerProfile{}, err
	}
	prof, err := s.customers.CustomerProfile(ctx, p.UserID)
	if err != nil {
		return identity.Principal{}, identity.CustomerProfile{}, err
	}
	return p, prof, nil
}

func principal(ctx context.Context) (identity.Principal, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return identity.Principal{}, problem.Unauthorized()
	}
	return p, nil
}

func isUnique(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// Owned is one of the customer's accounts with its balances, or ErrAccountNotFound.
func (s *Service) Owned(ctx context.Context, userID, accountID uuid.UUID) (accountsdb.GetCustomerAccountRow, error) {
	return s.own(ctx, userID, accountID)
}

// ErrNoSuchNuban is the mock bank's 404 for an account number no Nem customer has.
var ErrNoSuchNuban = problem.New(http.StatusNotFound, "account_not_found", "No Nem account has that number")

// Recipient is a Nem customer's current account, found by its number.
type Recipient struct {
	accountsdb.CustomerAccount
	Name   string
	Nemtag *string
}

// ResolveNuban finds the Nem current account with this number.
func (s *Service) ResolveNuban(ctx context.Context, number string) (Recipient, error) {
	acc, err := s.q.GetCurrentAccountByNumber(ctx, number)
	if errors.Is(err, pgx.ErrNoRows) {
		return Recipient{}, ErrNoSuchNuban
	}
	if err != nil {
		return Recipient{}, fmt.Errorf("load account by number: %w", err)
	}
	prof, err := s.customers.CustomerProfile(ctx, acc.UserID)
	if err != nil {
		return Recipient{}, err
	}
	return Recipient{CustomerAccount: acc, Name: prof.Name, Nemtag: prof.Nemtag}, nil
}

// ResolveCustomer finds the customer's Nem current account, for paying them by @nemtag or
// phone instead of by number.
func (s *Service) ResolveCustomer(ctx context.Context, userID uuid.UUID) (Recipient, error) {
	acc, err := s.q.GetCustomerAccountByCurrency(ctx, accountsdb.GetCustomerAccountByCurrencyParams{UserID: userID, Currency: string(money.NGN)})
	if errors.Is(err, pgx.ErrNoRows) {
		return Recipient{}, ErrNoSuchNuban
	}
	if err != nil {
		return Recipient{}, fmt.Errorf("load current account: %w", err)
	}
	prof, err := s.customers.CustomerProfile(ctx, userID)
	if err != nil {
		return Recipient{}, err
	}
	return Recipient{CustomerAccount: acc, Name: prof.Name, Nemtag: prof.Nemtag}, nil
}

// Decoy is the duress view of a balance (SEC-5): what a person forcing the customer can
// see, and so the most a transfer made under duress can appear to send.
func Decoy(m money.Money) money.Money { return decoy(m) }

// RecipientByAccount finds the Nem customer behind a current account, for a transfer that
// waited and is now landing.
func (s *Service) RecipientByAccount(ctx context.Context, accountID uuid.UUID) (Recipient, error) {
	acc, err := s.q.GetCustomerAccountByID(ctx, accountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Recipient{}, ErrNoSuchNuban
	}
	if err != nil {
		return Recipient{}, fmt.Errorf("load account: %w", err)
	}
	prof, err := s.customers.CustomerProfile(ctx, acc.UserID)
	if err != nil {
		return Recipient{}, err
	}
	return Recipient{CustomerAccount: acc, Name: prof.Name, Nemtag: prof.Nemtag}, nil
}

// Naira is the customer's NGN current account, where savings payouts land.
func (s *Service) Naira(ctx context.Context, userID uuid.UUID) (accountsdb.CustomerAccount, error) {
	a, err := s.q.GetCustomerAccountByCurrency(ctx, accountsdb.GetCustomerAccountByCurrencyParams{UserID: userID, Currency: string(money.NGN)})
	if errors.Is(err, pgx.ErrNoRows) {
		return accountsdb.CustomerAccount{}, ErrAccountNotFound
	}
	if err != nil {
		return accountsdb.CustomerAccount{}, fmt.Errorf("load naira account: %w", err)
	}
	return a, nil
}
