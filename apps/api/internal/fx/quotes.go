package fx

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts/accountsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/fx/fxdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/pagination"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// QuoteRequest asks for a rate. Exactly one of Sell and Buy is set.
type QuoteRequest struct {
	From, To uuid.UUID
	// Sell is the amount leaving From; Buy is the amount arriving in To.
	Sell, Buy *money.Money
}

// QuoteView is a locked rate (contract FxQuote).
type QuoteView struct {
	ID       uuid.UUID
	From, To uuid.UUID
	Sell     money.Money
	Buy      money.Money
	// Rate is units of the bought currency per unit sold, spread included.
	Rate, Mid Rate
	SpreadBPS int
	Fee       money.Money
	ExpiresAt time.Time
}

func quoteView(q fxdb.FxQuote) QuoteView {
	return QuoteView{
		ID: q.ID, From: q.FromAccountID, To: q.ToAccountID,
		Sell: money.New(q.SellMinor, money.Currency(q.SellCurrency)), Buy: money.New(q.BuyMinor, money.Currency(q.BuyCurrency)),
		Rate: Rate(q.RateE8), Mid: Rate(q.MidE8), SpreadBPS: int(q.SpreadBps),
		Fee: money.Zero(money.Currency(q.SellCurrency)), ExpiresAt: q.ExpiresAt.UTC(),
	}
}

// Quote locks the current rate for the quote TTL (FX-1). The amounts are worked out now and
// stored, so Convert posts exactly what the customer saw.
//
// Rounding keeps the odd fraction of a minor unit with the bank, never the customer: a
// fixed sell amount buys the rate's product rounded down, and a fixed buy amount costs the
// quotient rounded up (so the customer receives at least what they asked for, and pays at
// most one minor unit more than the exact price).
func (s *Service) Quote(ctx context.Context, in QuoteRequest) (QuoteView, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return QuoteView{}, problem.Unauthorized()
	}
	from, err := s.usable(ctx, p.UserID, in.From)
	if err != nil {
		return QuoteView{}, err
	}
	to, err := s.usable(ctx, p.UserID, in.To)
	if err != nil {
		return QuoteView{}, err
	}
	sellC, buyC := money.Currency(from.Currency), money.Currency(to.Currency)
	switch {
	case sellC == buyC:
		return QuoteView{}, errSameCurrency
	case sellC != money.NGN && buyC != money.NGN:
		return QuoteView{}, errViaNaira
	case (in.Sell == nil) == (in.Buy == nil):
		return QuoteView{}, errAmountChoice
	}
	if err := checkAmount(in.Sell, "/sell_amount", sellC); err != nil {
		return QuoteView{}, err
	}
	if err := checkAmount(in.Buy, "/buy_amount", buyC); err != nil {
		return QuoteView{}, err
	}

	buyingForeign := sellC == money.NGN
	foreign := sellC
	if buyingForeign {
		foreign = buyC
	}
	pair := string(foreign) + "-NGN"
	row, err := s.latest(ctx, s.q, pair)
	if err != nil {
		return QuoteView{}, err
	}
	bps := s.spread(pair)
	rate, mid, err := customerRate(Rate(row.MidE8), bps, buyingForeign)
	if err != nil {
		return QuoteView{}, fmt.Errorf("customer rate for %s: %w", pair, err)
	}

	var sell, buy int64
	if in.Sell != nil {
		sell = in.Sell.Amount()
		buy, err = rate.Apply(sell, money.Floor)
	} else {
		buy = in.Buy.Amount()
		sell, err = rate.Divide(buy, money.Ceil)
	}
	if errors.Is(err, money.ErrOverflow) {
		return QuoteView{}, errTooLarge
	}
	if err != nil {
		return QuoteView{}, fmt.Errorf("quote amounts: %w", err)
	}
	if buy <= 0 || sell <= 0 {
		return QuoteView{}, errTooSmall
	}

	id, err := uuid.NewV7()
	if err != nil {
		return QuoteView{}, fmt.Errorf("quote id: %w", err)
	}
	now := s.now().UTC()
	q, err := s.q.InsertQuote(ctx, fxdb.InsertQuoteParams{
		ID: id, UserID: p.UserID, FromAccountID: from.AccountID, ToAccountID: to.AccountID,
		SellCurrency: from.Currency, SellMinor: sell, BuyCurrency: to.Currency, BuyMinor: buy,
		RateE8: int64(rate), MidE8: int64(mid), SpreadBps: int32(bps), //nolint:gosec // 0-9999, checked in NewService
		CreatedAt: now, ExpiresAt: now.Add(s.quoteTTL),
	})
	if err != nil {
		return QuoteView{}, fmt.Errorf("insert quote: %w", err)
	}
	return quoteView(q), nil
}

// customerRate is the rate a customer gets, and the mid it came from, in units of the
// bought currency per unit sold. Selling foreign currency pays the discounted rate; buying
// it costs the marked-up rate, inverted because the customer is spending naira.
func customerRate(mid Rate, bps int, buyingForeign bool) (rate, midOut Rate, err error) {
	if !buyingForeign {
		rate, err = mid.Discount(bps)
		return rate, mid, err
	}
	ask, err := mid.Markup(bps)
	if err != nil {
		return 0, 0, err
	}
	if rate, err = ask.Invert(); err != nil {
		return 0, 0, err
	}
	if midOut, err = mid.Invert(); err != nil {
		return 0, 0, err
	}
	return rate, midOut, nil
}

func checkAmount(m *money.Money, field string, want money.Currency) error {
	if m == nil {
		return nil
	}
	if m.Currency() != want {
		return problem.Validation(problem.Field(field, "currency_mismatch", "This amount must be in "+string(want)+"."))
	}
	if !m.IsPositive() {
		return problem.Validation(problem.Field(field, "positive", "Enter an amount above zero."))
	}
	return nil
}

// usable is one of the caller's own accounts, if it can take part in a conversion.
func (s *Service) usable(ctx context.Context, userID, id uuid.UUID) (accountsdb.GetCustomerAccountRow, error) {
	a, err := s.accounts.Owned(ctx, userID, id)
	if err != nil {
		return accountsdb.GetCustomerAccountRow{}, err
	}
	if a.Status != "active" {
		return accountsdb.GetCustomerAccountRow{}, errNotActive
	}
	return a, nil
}

// ConversionView is a completed conversion (contract FxConversion).
type ConversionView struct {
	ID, QuoteID                         uuid.UUID
	Sell, Buy                           money.Money
	Rate                                Rate
	Fee                                 money.Money
	Status                              string
	DebitTransaction, CreditTransaction uuid.UUID
	CreatedAt                           time.Time
}

// Convert makes the exchange a quote promised (FX-1). The quote row is locked for the whole
// transaction, so two requests for one quote take turns and the second finds it used; the
// ledger entry carries the quote's idempotency key as a second guard. Both customer
// statement lines are written beside the entry, and everything commits or nothing does.
//
// The ledger entry has four legs. The customer's sold currency moves to the bank's FX
// position in that currency, and the bank's position in the bought currency pays the
// customer. Each currency nets to zero by itself; no rate is stored in the ledger.
func (s *Service) Convert(ctx context.Context, quoteID uuid.UUID) (ConversionView, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return ConversionView{}, problem.Unauthorized()
	}
	// Everything that reads through the pool happens before the transaction opens. A
	// transaction that needed a second connection while holding its first would deadlock the
	// pool as soon as as many conversions as it has connections ran at once.
	pre, err := s.GetQuote(ctx, p.UserID, quoteID)
	if err != nil {
		return ConversionView{}, err
	}
	from, err := s.usable(ctx, p.UserID, pre.FromAccountID)
	if err != nil {
		return ConversionView{}, err
	}
	to, err := s.usable(ctx, p.UserID, pre.ToAccountID)
	if err != nil {
		return ConversionView{}, err
	}
	balanceCap, err := s.balanceCap(ctx, p.UserID, to)
	if err != nil {
		return ConversionView{}, err
	}

	var out ConversionView
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := fxdb.New(tx)
		quote, err := q.LockQuote(ctx, fxdb.LockQuoteParams{ID: quoteID, UserID: p.UserID})
		if err != nil {
			return fmt.Errorf("lock quote: %w", err)
		}
		if _, err := q.GetConversionByQuote(ctx, quote.ID); err == nil {
			return errQuoteUsed
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("check quote use: %w", err)
		}
		now := s.now().UTC()
		if !now.Before(quote.ExpiresAt) {
			return errQuoteExpired
		}
		sell := money.New(quote.SellMinor, money.Currency(quote.SellCurrency))
		buy := money.New(quote.BuyMinor, money.Currency(quote.BuyCurrency))
		sellPos, err := ledger.SystemAccount(ctx, tx, ledger.KindFXPosition, quote.SellCurrency)
		if err != nil {
			return err
		}
		buyPos, err := ledger.SystemAccount(ctx, tx, ledger.KindFXPosition, quote.BuyCurrency)
		if err != nil {
			return err
		}
		posted, err := ledger.Post(ctx, tx, ledger.Entry{
			Kind: "fx_conversion", Reference: reference(quote.ID), IdempotencyKey: "fx:" + quote.ID.String(),
			Metadata: map[string]any{"quote_id": quote.ID.String(), "rate": Rate(quote.RateE8).String(), "spread_bps": quote.SpreadBps},
			Legs: []ledger.Leg{
				ledger.Debit(from.AccountID, sell), ledger.Credit(sellPos.ID, sell),
				ledger.Debit(buyPos.ID, buy), ledger.Credit(to.AccountID, buy),
			},
		})
		if errors.Is(err, ledger.ErrDuplicateEntry) {
			return errQuoteUsed
		}
		if err != nil {
			return fmt.Errorf("post conversion: %w", err)
		}
		// Judged on the balance the posting produced (the account row is locked by it), so
		// concurrent credits cannot slip past the cap together.
		if after := accounts.BalanceAfter(posted, to.AccountID); balanceCap > 0 && after != nil && *after > balanceCap {
			return errMaxBalance
		}

		debitID, err := uuid.NewV7()
		if err != nil {
			return fmt.Errorf("transaction id: %w", err)
		}
		creditID, err := uuid.NewV7()
		if err != nil {
			return fmt.Errorf("transaction id: %w", err)
		}
		narration := fmt.Sprintf("Converted %s to %s", sell.Currency(), buy.Currency())
		line := func(id uuid.UUID, acct uuid.UUID, direction string, amount money.Money) error {
			_, err := accounts.Record(ctx, tx, accounts.Line{
				ID: id, UserID: p.UserID, AccountID: acct, Type: "fx_conversion", Direction: direction, Status: "completed",
				Amount: amount, Entry: &posted, Narration: narration, Reference: reference(quote.ID), Category: "transfers",
				Counterparty: api.Counterparty{Name: "Nem FX"},
			})
			return err
		}
		if err := line(debitID, from.AccountID, "debit", sell); err != nil {
			return err
		}
		if err := line(creditID, to.AccountID, "credit", buy); err != nil {
			return err
		}

		convID, err := uuid.NewV7()
		if err != nil {
			return fmt.Errorf("conversion id: %w", err)
		}
		row, err := q.InsertConversion(ctx, fxdb.InsertConversionParams{
			ID: convID, UserID: p.UserID, QuoteID: quote.ID, EntryID: posted.EntryID,
			DebitTransactionID: debitID, CreditTransactionID: creditID, CreatedAt: now,
		})
		if err != nil {
			return fmt.Errorf("insert conversion: %w", err)
		}
		out = ConversionView{
			ID: row.ID, QuoteID: quote.ID, Sell: sell, Buy: buy, Rate: Rate(quote.RateE8), Fee: money.New(quote.FeeMinor, sell.Currency()),
			Status: row.Status, DebitTransaction: debitID, CreditTransaction: creditID, CreatedAt: row.CreatedAt.UTC(),
		}
		return nil
	})
	if err != nil {
		return ConversionView{}, err
	}
	return out, nil
}

// balanceCap is the KYC tier's cap on a naira balance (0: none) when the conversion pays
// into the naira account, as transfers do; wallets have no cap.
func (s *Service) balanceCap(ctx context.Context, userID uuid.UUID, to accountsdb.GetCustomerAccountRow) (int64, error) {
	if to.Currency != string(money.NGN) {
		return 0, nil
	}
	prof, err := s.customers.CustomerProfile(ctx, userID)
	if err != nil {
		return 0, fmt.Errorf("customer profile: %w", err)
	}
	return s.limits.Rules().Tier(prof.KycTier).MaxBalanceMinor, nil
}

// GetQuote reads one of the caller's quotes, or ErrQuoteNotFound.
func (s *Service) GetQuote(ctx context.Context, userID, id uuid.UUID) (fxdb.FxQuote, error) {
	q, err := s.q.GetQuote(ctx, fxdb.GetQuoteParams{ID: id, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return fxdb.FxQuote{}, ErrQuoteNotFound
	}
	if err != nil {
		return fxdb.FxQuote{}, fmt.Errorf("load quote: %w", err)
	}
	return q, nil
}

// reference is the statement reference of a conversion: FX plus the quote's random tail.
func reference(quoteID uuid.UUID) string {
	return "FX-" + strings.ToUpper(strings.ReplaceAll(quoteID.String(), "-", "")[20:])
}

// Conversions lists the caller's conversions, newest first (FX-4).
func (s *Service) Conversions(ctx context.Context, cursor *string, limit *int) ([]ConversionView, api.PageInfo, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return nil, api.PageInfo{}, problem.Unauthorized()
	}
	after, err := pagination.Decode(cursor)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	n := pagination.Limit(limit)
	rows, err := s.q.ListConversions(ctx, fxdb.ListConversionsParams{
		UserID: p.UserID, AfterID: after.ID, AfterAt: after.Time, RowLimit: int32(n + 1), //nolint:gosec // n <= pagination.MaxLimit
	})
	if err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("list conversions: %w", err)
	}
	rows, page := pagination.Page(rows, n, func(r fxdb.ListConversionsRow) pagination.Cursor {
		return pagination.Cursor{Time: r.CreatedAt, ID: r.ID}
	})
	out := make([]ConversionView, len(rows))
	for i, r := range rows {
		sellC := money.Currency(r.SellCurrency)
		out[i] = ConversionView{
			ID: r.ID, QuoteID: r.QuoteID, Sell: money.New(r.SellMinor, sellC),
			Buy: money.New(r.BuyMinor, money.Currency(r.BuyCurrency)), Rate: Rate(r.RateE8), Fee: money.New(r.FeeMinor, sellC),
			Status: r.Status, DebitTransaction: r.DebitTransactionID, CreditTransaction: r.CreditTransactionID, CreatedAt: r.CreatedAt.UTC(),
		}
	}
	return out, page, nil
}
