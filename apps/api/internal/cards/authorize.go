package cards

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/cards/cardsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// Decline reasons (contract CardTransaction.decline_reason).
const (
	DeclineInsufficientFunds     = "insufficient_funds"
	DeclineCardFrozen            = "card_frozen"
	DeclineLimitExceeded         = "limit_exceeded"
	DeclineOnlineDisabled        = "online_disabled"
	DeclineInternationalDisabled = "international_disabled"
	DeclineMerchantNotAllowed    = "merchant_not_allowed"
	DeclineCardUsed              = "card_used"

	// Authorization statuses (contract CardTransactionStatus).
	AuthAuthorized = "authorized"
	AuthSettled    = "settled"
	AuthReversed   = "reversed"
	AuthDeclined   = "declined"

	// Channels.
	ChannelOnline  = "online"
	ChannelInStore = "in_store"

	// HoldLifetime is how long an unsettled authorization holds money: networks let one
	// stand for about a week (the mock bank's AUTH_HOLD_DAYS).
	HoldLifetime = 7 * 24 * time.Hour
	// HomeCountry is where a charge is domestic. Anything else is international (CARD-4).
	HomeCountry = "NG"
)

// errInvalidCard is every reason a number cannot be charged at all: unknown, wrong expiry,
// wrong CVV, expired, terminated. One answer for all of them, so the processor cannot be
// used to find out which part of a guessed card is right.
var errInvalidCard = problem.New(http.StatusUnprocessableEntity, "invalid_card", "The card details are not valid").
	WithDetail("The number, expiry or CVV does not match an active card.")

// lagos is West Africa Time; Nigeria has no daylight saving.
var lagos = time.FixedZone("WAT", 3600)

// Merchant is who is asking to be paid.
type Merchant struct{ ID, Name, MCC, Country string }

// ChargeRequest is a merchant's authorization request, as it would arrive from a network.
type ChargeRequest struct {
	PAN, CVV    string
	Month, Year int
	Amount      money.Money
	Merchant    Merchant
	Channel     string
}

// periodStart is the start of the Lagos day or month a limit counts from.
func periodStart(period string, now time.Time) (time.Time, bool) {
	y, m, d := now.In(lagos).Date()
	switch period {
	case Daily:
		return time.Date(y, m, d, 0, 0, 0, 0, lagos), true
	case Monthly:
		return time.Date(y, m, 1, 0, 0, 0, 0, lagos), true
	}
	return time.Time{}, false
}

// facts are what the decision needs besides the card and the request.
type facts struct {
	billing money.Money
	// accountActive is false when the card's account is frozen or closed.
	accountActive bool
	// spent is what the card was charged in the current limit period.
	spent int64
	// charges counts approved and settled charges, for single-use cards.
	charges int64
}

// decide applies the card's controls to a charge and returns the decline reason, or "" to
// approve. The order is fixed and meant to be read: what the customer switched off first,
// then the limits, then the single-use rule. Funds come last, in the ledger, where the hold
// is placed under the account's lock.
func decide(card cardsdb.Card, req ChargeRequest, f facts) string {
	switch {
	case card.Status == StatusUsed:
		return DeclineCardUsed
	case card.Status == StatusFrozen || !f.accountActive:
		return DeclineCardFrozen
	case req.Channel == ChannelOnline && !card.OnlineEnabled:
		return DeclineOnlineDisabled
	case req.Merchant.Country != HomeCountry && !card.InternationalEnabled:
		return DeclineInternationalDisabled
	case card.MerchantID != nil && *card.MerchantID != req.Merchant.ID:
		return DeclineMerchantNotAllowed
	}
	if card.SpendLimitMinor != nil {
		limit := *card.SpendLimitMinor
		// Per-transaction limits ignore history; the others add this charge to the period's.
		total := f.billing.Amount()
		if card.SpendLimitPeriod != nil && *card.SpendLimitPeriod != PerTransaction {
			total += f.spent
		}
		if total > limit || total < 0 {
			return DeclineLimitExceeded
		}
	}
	if card.Type == TypeSingleUse && f.charges > 0 {
		return DeclineCardUsed
	}
	return ""
}

// expired reports whether the card's last month has passed.
func expired(card cardsdb.Card, now time.Time) bool {
	end := time.Date(int(card.ExpiryYear), time.Month(card.ExpiryMonth)+1, 1, 0, 0, 0, 0, time.UTC)
	return !now.Before(end)
}

// matches checks the details a merchant sent against the card without revealing which part
// was wrong, in constant time for the secret part.
func (s *Service) matches(card cardsdb.Card, pan string, req ChargeRequest) bool {
	ok := int(card.ExpiryMonth) == req.Month && int(card.ExpiryYear) == req.Year
	want := s.cvvFor(pan, card.ExpiryMonth, card.ExpiryYear)
	return subtle.ConstantTimeCompare([]byte(want), []byte(req.CVV)) == 1 && ok
}

// Authorize is the processor's decision on a merchant's request (CARD-7). Approved, the
// amount in the card's currency is held on the card's account until the merchant settles
// or the hold lapses; declined, the attempt and its reason are recorded and nothing is
// held. A request that does not match any active card is an error and records nothing: there
// is no card to attach it to.
//
// Everything that decides on one card runs under that card's row lock, so two charges
// racing for the last of a limit, or for a single-use card, are decided one after the other.
func (s *Service) Authorize(ctx context.Context, req ChargeRequest) (cardsdb.CardAuthorization, error) {
	if !luhnValid(req.PAN) || len(req.PAN) != 16 || !req.Amount.IsPositive() {
		return cardsdb.CardAuthorization{}, errInvalidCard
	}
	now := s.now().UTC()
	// Reads through the pool come first: a transaction that needed a second connection
	// would starve the pool under load (T25.6, T26.2).
	card, err := s.q.GetCardByPanIndex(ctx, s.keyring.BlindIndex(panDomain, []byte(req.PAN)))
	if errors.Is(err, pgx.ErrNoRows) {
		return cardsdb.CardAuthorization{}, errInvalidCard
	}
	if err != nil {
		return cardsdb.CardAuthorization{}, fmt.Errorf("find card: %w", err)
	}
	if !s.matches(card, req.PAN, req) || card.Status == StatusTerminated || expired(card, now) {
		return cardsdb.CardAuthorization{}, errInvalidCard
	}
	billed, err := s.billingFor(ctx, req.Amount, money.Currency(card.Currency))
	if err != nil {
		return cardsdb.CardAuthorization{}, err
	}
	acc, err := s.accounts.Owned(ctx, card.UserID, card.AccountID)
	if err != nil {
		return cardsdb.CardAuthorization{}, err
	}

	var out cardsdb.CardAuthorization
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		locked, err := q.LockCard(ctx, card.ID)
		if err != nil {
			return fmt.Errorf("lock card: %w", err)
		}
		if locked.Status == StatusTerminated {
			return errInvalidCard // terminated between the lookup and the lock
		}
		f := facts{billing: billed, accountActive: acc.Status == "active"}
		if locked.SpendLimitPeriod != nil {
			if since, ok := periodStart(*locked.SpendLimitPeriod, now); ok {
				if f.spent, err = q.SpendSince(ctx, cardsdb.SpendSinceParams{CardID: locked.ID, Since: since}); err != nil {
					return fmt.Errorf("sum card spend: %w", err)
				}
			}
		}
		if locked.Type == TypeSingleUse {
			if f.charges, err = q.CountCharges(ctx, locked.ID); err != nil {
				return fmt.Errorf("count card charges: %w", err)
			}
		}
		id, err := uuid.NewV7()
		if err != nil {
			return fmt.Errorf("authorization id: %w", err)
		}
		row := cardsdb.InsertAuthorizationParams{
			ID: id, CardID: locked.ID, UserID: locked.UserID, AccountID: locked.AccountID, MerchantID: req.Merchant.ID,
			MerchantName: req.Merchant.Name, Mcc: req.Merchant.MCC, Country: req.Merchant.Country, Channel: req.Channel,
			AmountMinor: req.Amount.Amount(), AmountCurrency: string(req.Amount.Currency()),
			BillingMinor: billed.Amount(), BillingCurrency: string(billed.Currency()), AuthorizedAt: now,
		}
		decline := decide(locked, req, f)
		if decline == "" {
			expiresAt := now.Add(HoldLifetime)
			hold, err := ledger.PlaceHold(ctx, tx, ledger.Hold{
				Account: locked.AccountID, Amount: billed, Reference: id.String(), Reason: "card_authorization", ExpiresAt: &expiresAt,
			})
			switch {
			case errors.Is(err, ledger.ErrInsufficientFunds):
				decline = DeclineInsufficientFunds
			case err != nil:
				return fmt.Errorf("hold card funds: %w", err)
			default:
				row.HoldID, row.ExpiresAt, row.Status = &hold.ID, &expiresAt, AuthAuthorized
			}
		}
		if decline != "" {
			row.Status, row.DeclineReason = AuthDeclined, &decline
		}
		out, err = q.InsertAuthorization(ctx, row)
		if err != nil {
			return fmt.Errorf("record authorization: %w", err)
		}
		return nil
	})
	return out, err
}

// billingFor prices a charge in the card's currency, asking for rates only when the
// currencies differ.
func (s *Service) billingFor(ctx context.Context, amount money.Money, card money.Currency) (money.Money, error) {
	if amount.Currency() == card {
		return amount, nil
	}
	if s.rates == nil {
		return money.Money{}, errRates
	}
	views, err := s.rates.Rates(ctx)
	if err != nil {
		return money.Money{}, err
	}
	return billing(amount, card, views)
}
