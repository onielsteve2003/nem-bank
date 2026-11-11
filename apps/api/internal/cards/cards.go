// Package cards is Nem's simulated card processor (FR-CARD): virtual cards on a test BIN,
// their controls, and the authorization engine the Merchant Simulator charges through.
//
// Card numbers are Luhn-valid but live only inside Nem. The number is stored encrypted and
// found by a blind index; the CVV is derived, never stored; the full details leave the
// system through one door, the step-up-gated reveal.
package cards

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts/accountsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/audit"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/cards/cardsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/categorize"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/fieldcrypt"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// Policy, with the mock bank's numbers.
const (
	// maxLiveCards is how many active or frozen cards one customer can hold.
	maxLiveCards = 5
	// cardTier is the KYC tier cards need (the mock bank's requireTier(2, 'Cards')).
	cardTier = 2
	// cardLifetimeYears is how far ahead a new card's expiry is.
	cardLifetimeYears = 4
	// RevealWindow is how long the app may show the details (CARD-3).
	RevealWindow = 30 * time.Second

	// StepUpReveal and StepUpUnfreeze are the step-up purposes (contract StepUpPurpose).
	StepUpReveal   = "card_reveal"
	StepUpUnfreeze = "unfreeze"

	// Card types and statuses (contract CardType, CardStatus).
	TypeStandard       = "standard"
	TypeSingleUse      = "single_use"
	TypeMerchantLocked = "merchant_locked"
	StatusActive       = "active"
	StatusFrozen       = "frozen"
	StatusTerminated   = "terminated"
	StatusUsed         = "used"

	// Spend limit periods (contract SpendLimit.period).
	PerTransaction = "per_transaction"
	Daily          = "daily"
	Monthly        = "monthly"

	panDomain = "cards.pan"
	cvvDomain = "cards.cvv"
)

// Problems, with the mock bank's codes.
var (
	// ErrCardNotFound is the 404 for a card the caller does not have.
	ErrCardNotFound = problem.NotFound("Card")
	errTier         = problem.New(http.StatusForbidden, "kyc_tier_required", "Cards needs KYC Tier 2").
			WithDetail("Verify your identity in Profile → Verification to unlock it.")
	errNotActive = problem.New(http.StatusForbidden, "account_not_active", "This account cannot be used right now")
	errCardLimit = problem.New(http.StatusConflict, "limit_reached", fmt.Sprintf("You can have up to %d cards", maxLiveCards))
	errCurrency  = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "Cards are available for NGN and USD")
	errNeedLock  = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "Pick the merchant this card is locked to")
	errLimitCcy  = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "Set the spend limit in the card's currency")
	errNotLive   = problem.New(http.StatusConflict, "invalid_state", "This card is no longer active")
)

// Accounts is the customer's accounts; *accounts.Service implements it.
type Accounts interface {
	Owned(ctx context.Context, userID, accountID uuid.UUID) (accountsdb.GetCustomerAccountRow, error)
}

// Customers tells cards a customer's name and KYC tier; identity.Service implements it.
type Customers interface {
	CustomerProfile(ctx context.Context, userID uuid.UUID) (identity.CustomerProfile, error)
}

// StepUps spends step-up tokens inside the caller's transaction; identity.Service
// implements it.
type StepUps interface {
	ConsumeStepUp(ctx context.Context, tx pgx.Tx, userID uuid.UUID, purpose, token string) error
}

// Config holds the service's dependencies.
type Config struct {
	Pool      *pgxpool.Pool
	Accounts  Accounts
	Customers Customers
	StepUps   StepUps
	Keyring   *fieldcrypt.Keyring
	// Rates prices charges in a currency other than the card's; nil refuses them.
	Rates Rater
	// Categorizer files card payments by merchant name (AI-3); nil leaves the merchant
	// category code's answer alone.
	Categorizer *categorize.Classifier
	Logger      *slog.Logger
	// Now defaults to time.Now.
	Now func() time.Time
}

// Service is the card domain.
type Service struct {
	pool      *pgxpool.Pool
	q         *cardsdb.Queries
	accounts  Accounts
	customers Customers
	stepUps   StepUps
	keyring   *fieldcrypt.Keyring
	rates     Rater
	// categorizer is nil when smart categories is off.
	categorizer *categorize.Classifier
	log         *slog.Logger
	now         func() time.Time
}

// NewService builds the service.
func NewService(cfg Config) (*Service, error) {
	if cfg.Pool == nil || cfg.Accounts == nil || cfg.Customers == nil || cfg.StepUps == nil || cfg.Keyring == nil || cfg.Logger == nil {
		return nil, errors.New("cards: pool, accounts, customers, step-ups, keyring and logger are required")
	}
	s := &Service{
		pool: cfg.Pool, q: cardsdb.New(cfg.Pool), accounts: cfg.Accounts, customers: cfg.Customers, stepUps: cfg.StepUps,
		keyring: cfg.Keyring, rates: cfg.Rates, categorizer: cfg.Categorizer, log: cfg.Logger.With("component", "cards"), now: cfg.Now,
	}
	if s.now == nil {
		s.now = time.Now
	}
	return s, nil
}

// SpendLimit is a card's spend cap.
type SpendLimit struct {
	Amount money.Money
	Period string
}

// MerchantLock ties a card to one merchant.
type MerchantLock struct{ ID, Name string }

// IssueRequest is a new card's choices (contract CreateCardRequest).
type IssueRequest struct {
	AccountID    uuid.UUID
	Type         string
	Nickname     string
	Design       string
	MerchantLock *MerchantLock
	SpendLimit   *SpendLimit
}

// plan is an issue request that passed every check that reads through the pool, so the
// transaction that writes the card needs no second connection (the pool-starvation lesson
// from T25.6 and T26.2).
type plan struct {
	userID        uuid.UUID
	accountID     uuid.UUID
	currency      string
	cardType      string
	design        string
	nickname      *string
	limit         *SpendLimit
	lock          *MerchantLock
	name          string
	international bool
	online        bool
}

func cleanNickname(s string) (*string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, nil //nolint:nilnil // no nickname is a valid value
	}
	if len([]rune(s)) > 30 {
		return nil, problem.Validation(problem.Field("/nickname", "too_long", "Use 30 characters or fewer."))
	}
	return &s, nil
}

func checkLimit(l *SpendLimit, currency string) error {
	if l == nil {
		return nil
	}
	if string(l.Amount.Currency()) != currency {
		return errLimitCcy
	}
	if !l.Amount.IsPositive() {
		return problem.Validation(problem.Field("/spend_limit/amount", "invalid", "Enter an amount above zero."))
	}
	return nil
}

// prepare checks an issue request against the customer and the account.
func (s *Service) prepare(ctx context.Context, userID uuid.UUID, in IssueRequest) (plan, error) {
	profile, err := s.customers.CustomerProfile(ctx, userID)
	if err != nil {
		return plan{}, err
	}
	if profile.KycTier < cardTier {
		return plan{}, errTier
	}
	acc, err := s.accounts.Owned(ctx, userID, in.AccountID)
	if err != nil {
		return plan{}, err
	}
	if acc.Currency != string(money.NGN) && acc.Currency != string(money.USD) {
		return plan{}, errCurrency
	}
	if acc.Status != "active" {
		return plan{}, errNotActive
	}
	if in.Type == TypeMerchantLocked && in.MerchantLock == nil {
		return plan{}, errNeedLock
	}
	if err := checkLimit(in.SpendLimit, acc.Currency); err != nil {
		return plan{}, err
	}
	nick, err := cleanNickname(in.Nickname)
	if err != nil {
		return plan{}, err
	}
	design := in.Design
	if design == "" {
		design = "volt"
	}
	return plan{
		userID: userID, accountID: acc.AccountID, currency: acc.Currency, cardType: in.Type, design: design, nickname: nick,
		limit: in.SpendLimit, lock: in.MerchantLock, name: strings.ToUpper(profile.Name),
		// Dollar cards work abroad from the start; naira cards are home-only until switched on.
		international: acc.Currency == string(money.USD), online: true,
	}, nil
}

// insert writes the card in tx: the customer's card count is checked under a per-customer
// lock, the number is generated, encrypted and indexed.
func (s *Service) insert(ctx context.Context, tx pgx.Tx, p plan) (cardsdb.Card, error) {
	q := s.q.WithTx(tx)
	if err := q.LockUserCards(ctx, p.userID.String()); err != nil {
		return cardsdb.Card{}, fmt.Errorf("lock customer cards: %w", err)
	}
	live, err := q.CountLiveCards(ctx, p.userID)
	if err != nil {
		return cardsdb.Card{}, fmt.Errorf("count cards: %w", err)
	}
	if live >= maxLiveCards {
		return cardsdb.Card{}, errCardLimit
	}
	id, err := uuid.NewV7()
	if err != nil {
		return cardsdb.Card{}, fmt.Errorf("card id: %w", err)
	}
	bin, network := binVerve, "nem_verve"
	if p.currency == string(money.USD) {
		bin, network = binVisa, "nem_visa"
	}
	pan, index, err := s.freshPAN(ctx, q, bin)
	if err != nil {
		return cardsdb.Card{}, err
	}
	enc, err := s.keyring.Encrypt([]byte(pan), panAAD(id))
	if err != nil {
		return cardsdb.Card{}, fmt.Errorf("encrypt card number: %w", err)
	}
	now := s.now().UTC()
	expiry := now.AddDate(cardLifetimeYears, 0, 0)
	arg := cardsdb.InsertCardParams{
		ID: id, UserID: p.userID, AccountID: p.accountID, Currency: p.currency, Type: p.cardType, Network: network,
		Last4: pan[len(pan)-4:], PanEnc: enc, PanIndex: index, ExpiryMonth: int32(expiry.Month()), ExpiryYear: int32(expiry.Year()), //nolint:gosec // a month and a year, both tiny
		NameOnCard: p.name, Nickname: p.nickname, Design: p.design, OnlineEnabled: p.online, InternationalEnabled: p.international,
		CreatedAt: now,
	}
	if p.limit != nil {
		minor, period := p.limit.Amount.Amount(), p.limit.Period
		arg.SpendLimitMinor, arg.SpendLimitPeriod = &minor, &period
	}
	if p.lock != nil {
		arg.MerchantID, arg.MerchantName = &p.lock.ID, &p.lock.Name
	}
	card, err := q.InsertCard(ctx, arg)
	if err != nil {
		return cardsdb.Card{}, fmt.Errorf("insert card: %w", err)
	}
	return card, nil
}

// freshPAN draws numbers until one is unused. A clash is a one-in-a-billion event per card;
// the unique index on the blind index is the backstop.
func (s *Service) freshPAN(ctx context.Context, q *cardsdb.Queries, bin string) (pan string, index []byte, err error) {
	for range 5 {
		pan, err = newPAN(bin)
		if err != nil {
			return "", nil, err
		}
		index = s.keyring.BlindIndex(panDomain, []byte(pan))
		taken, err := q.PanIndexTaken(ctx, index)
		if err != nil {
			return "", nil, fmt.Errorf("check card number: %w", err)
		}
		if !taken {
			return pan, index, nil
		}
	}
	return "", nil, errors.New("cards: could not draw an unused card number")
}

// Issue creates a card for the caller (CARD-1).
func (s *Service) Issue(ctx context.Context, in IssueRequest) (cardsdb.Card, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return cardsdb.Card{}, problem.Unauthorized()
	}
	plan, err := s.prepare(ctx, p.UserID, in)
	if err != nil {
		return cardsdb.Card{}, err
	}
	var card cardsdb.Card
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		card, err = s.insert(ctx, tx, plan)
		return err
	})
	return card, err
}

// Get is one of the caller's cards.
func (s *Service) Get(ctx context.Context, id uuid.UUID) (cardsdb.Card, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return cardsdb.Card{}, problem.Unauthorized()
	}
	card, err := s.q.GetCard(ctx, cardsdb.GetCardParams{ID: id, UserID: p.UserID})
	if errors.Is(err, pgx.ErrNoRows) {
		return cardsdb.Card{}, ErrCardNotFound
	}
	if err != nil {
		return cardsdb.Card{}, fmt.Errorf("load card: %w", err)
	}
	return card, nil
}

// List is every card the caller has, terminated ones last.
func (s *Service) List(ctx context.Context) ([]cardsdb.Card, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return nil, problem.Unauthorized()
	}
	rows, err := s.q.ListCards(ctx, p.UserID)
	if err != nil {
		return nil, fmt.Errorf("list cards: %w", err)
	}
	return rows, nil
}

// Secrets are a card's full details, shown once behind step-up.
type Secrets struct {
	CardID       uuid.UUID
	PAN, CVV     string
	Month, Year  int
	VisibleUntil time.Time
}

func panAAD(id uuid.UUID) []byte { return []byte("cards.pan:" + id.String()) }

// cvvFor derives the card's CVV from its number and expiry under the server's index key. A
// real processor does the same inside an HSM (CVK), so there is no CVV to leak from storage.
func (s *Service) cvvFor(pan string, month, year int32) string {
	mac := s.keyring.BlindIndex(cvvDomain, fmt.Appendf(nil, "%s|%02d|%d", pan, month, year))
	return fmt.Sprintf("%03d", binary.BigEndian.Uint32(mac[:4])%1000)
}

// Reveal returns the card's number and CVV (CARD-3). It spends a card_reveal step-up token
// in the same transaction as the audit entry, so a reveal without proof, or without a trace,
// cannot happen. Terminated cards are not revealed.
func (s *Service) Reveal(ctx context.Context, id uuid.UUID, stepUpToken string) (Secrets, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return Secrets{}, problem.Unauthorized()
	}
	card, err := s.Get(ctx, id)
	if err != nil {
		return Secrets{}, err
	}
	if card.Status == StatusTerminated || card.Status == StatusUsed {
		return Secrets{}, errNotLive
	}
	pan, err := s.keyring.Decrypt(card.PanEnc, panAAD(card.ID))
	if err != nil {
		return Secrets{}, fmt.Errorf("decrypt card %s: %w", card.ID, err)
	}
	now := s.now().UTC()
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := s.stepUps.ConsumeStepUp(ctx, tx, p.UserID, StepUpReveal, stepUpToken); err != nil {
			return err
		}
		_, err := audit.Append(ctx, tx, audit.Input{
			Actor: audit.Customer(p.UserID), Action: "card.reveal", ResourceType: "card", ResourceID: card.ID.String(),
		}, now)
		return err
	})
	if err != nil {
		return Secrets{}, err
	}
	return Secrets{
		CardID: card.ID, PAN: string(pan), CVV: s.cvvFor(string(pan), card.ExpiryMonth, card.ExpiryYear),
		Month: int(card.ExpiryMonth), Year: int(card.ExpiryYear), VisibleUntil: now.Add(RevealWindow),
	}, nil
}

func moneyOf(minor int64, currency string) money.Money {
	return money.New(minor, money.Currency(currency))
}
