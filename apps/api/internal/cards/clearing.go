package cards

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/cards/cardsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/pagination"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// Clearing (CARD-5). An approved authorization is a hold. The merchant later either
// captures it, and the hold becomes a ledger entry (customer → card settlement account),
// or reverses it, or never comes back and the hold lapses after HoldLifetime. Each of the
// three ends the authorization exactly once: they all take the card's row lock, then the
// authorization's, and act only on an authorization that is still "authorized".

var (
	errAuthNotFound = problem.NotFound("Authorization")
	errAuthClosed   = problem.New(http.StatusConflict, "authorization_closed", "This authorization is already settled or reversed")
	errAuthExpired  = problem.New(http.StatusConflict, "authorization_expired", "This authorization has expired").
			WithDetail("The hold lapsed before the merchant settled it.")
	errCaptureCcy  = problem.Validation(problem.Field("/amount", "wrong_currency", "Capture in the currency of the charge."))
	errCaptureOver = problem.Validation(problem.Field("/amount", "too_large", "A merchant cannot capture more than it authorized."))
	errCaptureZero = problem.Validation(problem.Field("/amount", "invalid", "Enter a valid amount."))
)

// captured prices a capture. A capture for less than the authorization (a final bill that
// came in lower) is charged in proportion to what was authorized, so the exchange rate the
// customer agreed to at authorization time carries through, rounded up to the bank's side.
func captured(a cardsdb.CardAuthorization, amount *money.Money) (merchant, billing money.Money, err error) {
	full := moneyOf(a.AmountMinor, a.AmountCurrency)
	billed := moneyOf(a.BillingMinor, a.BillingCurrency)
	if amount == nil {
		return full, billed, nil
	}
	if amount.Currency() != full.Currency() {
		return money.Money{}, money.Money{}, errCaptureCcy
	}
	if !amount.IsPositive() {
		return money.Money{}, money.Money{}, errCaptureZero
	}
	if amount.Amount() > full.Amount() {
		return money.Money{}, money.Money{}, errCaptureOver
	}
	if amount.Amount() == full.Amount() {
		return full, billed, nil
	}
	num := new(big.Int).Mul(big.NewInt(billed.Amount()), big.NewInt(amount.Amount()))
	q, r := new(big.Int).QuoRem(num, big.NewInt(full.Amount()), new(big.Int))
	if r.Sign() != 0 {
		q.Add(q, big.NewInt(1))
	}
	return *amount, money.New(q.Int64(), billed.Currency()), nil // at most billed, so it fits
}

// Capture settles an authorization: the held money becomes a ledger entry from the
// customer to the bank's card settlement account (CARD-5). amount nil captures all of it.
func (s *Service) Capture(ctx context.Context, id uuid.UUID, amount *money.Money) (cardsdb.CardAuthorization, error) {
	cardID, err := s.cardOf(ctx, id)
	if err != nil {
		return cardsdb.CardAuthorization{}, err
	}
	now := s.now().UTC()
	var out cardsdb.CardAuthorization
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		card, err := q.LockCard(ctx, cardID)
		if err != nil {
			return fmt.Errorf("lock card: %w", err)
		}
		a, err := q.LockAuthorization(ctx, id)
		if err != nil {
			return fmt.Errorf("lock authorization: %w", err)
		}
		if a.Status != AuthAuthorized {
			return errAuthClosed
		}
		if a.ExpiresAt != nil && !now.Before(*a.ExpiresAt) {
			return errAuthExpired
		}
		merchant, billing, err := captured(a, amount)
		if err != nil {
			return err
		}
		settlement, err := ledger.SystemAccount(ctx, tx, ledger.KindCardSettlement, a.BillingCurrency)
		if err != nil {
			return err
		}
		posted, err := ledger.Post(ctx, tx, ledger.Entry{
			Kind: "card_settlement", Reference: a.ID.String(), IdempotencyKey: "card_capture:" + a.ID.String(),
			Metadata: map[string]any{"authorization_id": a.ID.String(), "card_id": a.CardID.String(), "merchant_id": a.MerchantID},
			Legs:     []ledger.Leg{ledger.Debit(a.AccountID, billing), ledger.Credit(settlement.ID, billing)},
			Capture:  []uuid.UUID{*a.HoldID},
		})
		if err != nil {
			return fmt.Errorf("post card settlement: %w", err)
		}
		if _, err := accounts.SettleAmount(ctx, tx, *a.TransactionID, "completed", &posted, a.AccountID, &billing); err != nil {
			return err
		}
		out, err = q.CloseAuthorization(ctx, cardsdb.CloseAuthorizationParams{
			ID: a.ID, Status: AuthSettled, AmountMinor: merchant.Amount(), BillingMinor: billing.Amount(), SettledAt: &now,
		})
		if err != nil {
			return fmt.Errorf("settle authorization: %w", err)
		}
		// A single-use card is spent by its one capture.
		if card.Type == TypeSingleUse && card.Status != StatusTerminated {
			if _, err := q.SetCardStatus(ctx, cardsdb.SetCardStatusParams{
				ID: card.ID, Status: StatusUsed, FrozenByPanic: card.FrozenByPanic, TerminatedAt: card.TerminatedAt,
			}); err != nil {
				return fmt.Errorf("mark card used: %w", err)
			}
		}
		return emit(ctx, tx, card, out)
	})
	return out, err
}

// Reverse is the merchant cancelling an authorization: the hold is released and nothing
// is charged. A hold that has already lapsed can still be reversed; the expiry sweep finds
// the same rows, and whichever comes second sees it closed.
func (s *Service) Reverse(ctx context.Context, id uuid.UUID) (cardsdb.CardAuthorization, error) {
	cardID, err := s.cardOf(ctx, id)
	if err != nil {
		return cardsdb.CardAuthorization{}, err
	}
	var out cardsdb.CardAuthorization
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		card, err := q.LockCard(ctx, cardID)
		if err != nil {
			return fmt.Errorf("lock card: %w", err)
		}
		a, err := q.LockAuthorization(ctx, id)
		if err != nil {
			return fmt.Errorf("lock authorization: %w", err)
		}
		if a.Status != AuthAuthorized {
			return errAuthClosed
		}
		if err := ledger.ReleaseHold(ctx, tx, *a.HoldID); err != nil {
			return fmt.Errorf("release card hold: %w", err)
		}
		// Nothing was debited, so there is no entry to reverse: like a failed transfer, the
		// line ends "failed" (a "reversed" line needs the posting that reversed it).
		if _, err := accounts.Settle(ctx, tx, *a.TransactionID, "failed", nil, a.AccountID); err != nil {
			return err
		}
		out, err = q.CloseAuthorization(ctx, cardsdb.CloseAuthorizationParams{
			ID: a.ID, Status: AuthReversed, AmountMinor: a.AmountMinor, BillingMinor: a.BillingMinor,
		})
		if err != nil {
			return fmt.Errorf("reverse authorization: %w", err)
		}
		return emit(ctx, tx, card, out)
	})
	return out, err
}

// cardOf finds the card an authorization belongs to, outside any transaction: the card's
// lock must be taken before the authorization's.
func (s *Service) cardOf(ctx context.Context, id uuid.UUID) (uuid.UUID, error) {
	a, err := s.q.GetAuthorization(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, errAuthNotFound
	}
	if err != nil {
		return uuid.Nil, fmt.Errorf("find authorization: %w", err)
	}
	if a.Status == AuthDeclined {
		return uuid.Nil, errAuthClosed // nothing was held; there is nothing to settle
	}
	return a.CardID, nil
}

// Transactions lists a card's authorizations, newest first: pending ones, settled ones,
// reversed ones and declined attempts with their reason (CARD-5).
func (s *Service) Transactions(ctx context.Context, cardID uuid.UUID, cursor *string, limit *int) ([]cardsdb.CardAuthorization, api.PageInfo, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return nil, api.PageInfo{}, problem.Unauthorized()
	}
	if _, err := s.Get(ctx, cardID); err != nil {
		return nil, api.PageInfo{}, err
	}
	after, err := pagination.Decode(cursor)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	n := pagination.Limit(limit)
	rows, err := s.q.ListCardAuthorizations(ctx, cardsdb.ListCardAuthorizationsParams{
		CardID: cardID, UserID: p.UserID, AfterID: after.ID, AfterAt: after.Time, Lim: int32(n + 1), //nolint:gosec // n is at most pagination.MaxLimit
	})
	if err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("list card transactions: %w", err)
	}
	page, info := pagination.Page(rows, n, func(r cardsdb.CardAuthorization) pagination.Cursor {
		return pagination.Cursor{Time: r.AuthorizedAt, ID: r.ID}
	})
	return page, info, nil
}

// sweepBatch bounds one run of the expiry job; a backlog drains over the next runs.
const sweepBatch = 200

// ExpireHolds releases every authorization whose hold has lapsed (CARD-5): the merchant
// never settled, so the money goes back to the customer's available balance. It returns
// how many it released. Each is its own transaction, so one failure leaves the rest done.
func (s *Service) ExpireHolds(ctx context.Context) (int, error) {
	now := s.now().UTC()
	due, err := s.q.ListDueAuthorizations(ctx, cardsdb.ListDueAuthorizationsParams{Now: &now, Lim: sweepBatch})
	if err != nil {
		return 0, fmt.Errorf("list lapsed holds: %w", err)
	}
	released := 0
	for _, id := range due {
		_, err := s.Reverse(ctx, id)
		var p *problem.Error
		switch {
		case err == nil:
			released++
		case errors.As(err, &p) && p.Code == errAuthClosed.Code: // settled or reversed since the list was read
		default:
			s.log.Error("expire card hold", slog.String("authorization_id", id.String()), slog.Any("error", err))
		}
	}
	return released, nil
}

// ExpireArgs is the expiry sweep's job.
type ExpireArgs struct{}

// Kind implements river.JobArgs.
func (ExpireArgs) Kind() string { return "card_hold_expiry" }

type expireWorker struct {
	river.WorkerDefaults[ExpireArgs]
	s *Service
}

func (w *expireWorker) Work(ctx context.Context, _ *river.Job[ExpireArgs]) error {
	_, err := w.s.ExpireHolds(ctx)
	return err
}

// Register adds the card workers (jobs.Options.Workers).
func (s *Service) Register(w *river.Workers) { river.AddWorker(w, &expireWorker{s: s}) }

// PeriodicJobs are the card clocks (jobs.Options.Periodic): lapsed holds are released every
// fifteen minutes. A hold is days old before it lapses, so the exact minute does not matter.
func (s *Service) PeriodicJobs() []*river.PeriodicJob {
	return []*river.PeriodicJob{
		river.NewPeriodicJob(river.PeriodicInterval(15*time.Minute),
			func() (river.JobArgs, *river.InsertOpts) { return ExpireArgs{}, &river.InsertOpts{MaxAttempts: 3} },
			&river.PeriodicJobOpts{RunOnStart: true}),
	}
}
