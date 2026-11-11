package savings

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/savings/savingsdb"
)

// Locked savings terms (SAV-4). Demo values, shown to the customer before they lock.
const (
	// EarlyBreakPenaltyBps is the share of the interest earned so far that breaking early forfeits.
	EarlyBreakPenaltyBps = 5_000
	// minLock is ₦10,000 in kobo.
	minLock = 10_000_00
	// maxActiveLocks bounds the ledger accounts one customer can open this way.
	maxActiveLocks = 20
)

// lockRates are the yearly rates by term in days, in basis points (10% to 18%).
var lockRates = map[int]int{30: 1_000, 60: 1_100, 90: 1_400, 180: 1_600, 365: 1_800}

var (
	errTerm     = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "Pick 30, 60, 90, 180 or 365 days")
	errMinLock  = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "Lock at least ₦10,000")
	errTerms    = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "Accept the terms to lock your money")
	errTooLocks = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "You have too many locked savings").
			WithDetailf("Wait for one to mature before locking more (the limit is %d).", maxActiveLocks)
)

// Quote is a locked saving's terms, disclosed before the customer commits (SAV-4).
type Quote struct {
	Amount               money.Money
	TermDays, RateBps    int
	InterestAtMaturity   money.Money
	MaturityDate         time.Time
	EarlyBreakPenaltyBps int
	Explanation          string
}

// Lock is a locked saving (contract LockedSaving).
type Lock struct {
	ID                   uuid.UUID
	Principal            money.Money
	TermDays, RateBps    int
	StartDate            time.Time
	MaturityDate         time.Time
	AccruedInterest      money.Money
	ExpectedInterest     money.Money
	EarlyBreakPenaltyBps int
	Status               string
	PaidOut              *money.Money
}

// Quote prices a lock.
func (s *Service) Quote(amount money.Money, termDays int) (Quote, error) {
	rate, ok := lockRates[termDays]
	switch {
	case !ok:
		return Quote{}, errTerm
	case amount.Currency() != money.NGN:
		return Quote{}, errNaira
	case amount.Amount() < minLock || amount.Amount() > maxTarget:
		return Quote{}, errMinLock
	}
	return Quote{
		Amount: amount, TermDays: termDays, RateBps: rate, InterestAtMaturity: naira(SimpleInterest(amount.Amount(), rate, termDays)),
		MaturityDate: lagosDay(s.now()).AddDate(0, 0, termDays), EarlyBreakPenaltyBps: EarlyBreakPenaltyBps,
		Explanation: "You can break it any time, but you keep only half of the interest earned so far. Your full amount always comes back.",
	}, nil
}

func toLock(l savingsdb.LockedSaving) Lock {
	out := Lock{
		ID: l.ID, Principal: naira(l.PrincipalMinor), TermDays: int(l.TermDays), RateBps: int(l.RateBps), StartDate: l.StartDate,
		MaturityDate: l.MaturityDate, AccruedInterest: naira(l.AccruedInterestMinor), ExpectedInterest: naira(l.ExpectedInterestMinor),
		EarlyBreakPenaltyBps: int(l.EarlyBreakPenaltyBps), Status: l.Status,
	}
	if l.PaidOutMinor != nil {
		paid := naira(*l.PaidOutMinor)
		out.PaidOut = &paid
		// A finished lock shows the interest the customer actually received.
		out.AccruedInterest = naira(*l.PaidOutMinor - l.PrincipalMinor)
	}
	return out
}

// CreateLock locks money for a fixed term (SAV-4). The principal moves into the lock's own
// ledger account; the terms are fixed now, so a later change to the rate table never
// touches a lock already made.
func (s *Service) CreateLock(ctx context.Context, amount money.Money, termDays int, source uuid.UUID, acceptedTerms bool) (Lock, error) {
	p, err := principal(ctx)
	if err != nil {
		return Lock{}, err
	}
	if !acceptedTerms {
		return Lock{}, errTerms
	}
	quote, err := s.Quote(amount, termDays)
	if err != nil {
		return Lock{}, err
	}
	src, err := s.accounts.Owned(ctx, p.UserID, source)
	if err != nil {
		return Lock{}, err
	}
	if src.Status != "active" {
		return Lock{}, errNotActive
	}
	if src.Currency != string(money.NGN) {
		return Lock{}, errNaira
	}
	id, err := uuid.NewV7()
	if err != nil {
		return Lock{}, fmt.Errorf("lock id: %w", err)
	}
	now := s.now().UTC()
	var row savingsdb.LockedSaving
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := savingsdb.New(tx)
		if n, err := q.CountActiveLocks(ctx, p.UserID); err != nil {
			return fmt.Errorf("count locks: %w", err)
		} else if n >= maxActiveLocks {
			return errTooLocks
		}
		account, err := ledger.OpenCustomerAccount(ctx, tx, p.UserID, "customer_locked", string(money.NGN), "Locked savings")
		if err != nil {
			return err
		}
		ref := reference("LCK", id)
		posted, err := ledger.Post(ctx, tx, ledger.Entry{
			Kind: "savings", Reference: ref, IdempotencyKey: "lock:" + id.String(),
			Metadata: map[string]any{"lock_id": id.String(), "term_days": termDays},
			Legs:     []ledger.Leg{ledger.Debit(src.AccountID, amount), ledger.Credit(account, amount)},
		})
		if err != nil {
			return err
		}
		if err := s.record(ctx, tx, accounts.Line{
			UserID: p.UserID, AccountID: src.AccountID, Type: "savings", Direction: "debit", Status: "completed", Amount: amount,
			Entry: &posted, Narration: fmt.Sprintf("Locked savings (%d days)", termDays), Reference: ref, Category: "savings", At: now,
		}); err != nil {
			return err
		}
		row, err = q.InsertLock(ctx, savingsdb.InsertLockParams{
			ID: id, UserID: p.UserID, AccountID: account, PrincipalMinor: amount.Amount(), TermDays: int32(termDays), //nolint:gosec // a key of lockRates
			RateBps:              int32(quote.RateBps), //nolint:gosec // a value of lockRates
			EarlyBreakPenaltyBps: EarlyBreakPenaltyBps, StartDate: lagosDay(now),
			MaturityDate: quote.MaturityDate, ExpectedInterestMinor: quote.InterestAtMaturity.Amount(), CreatedAt: now,
		})
		if err != nil {
			return fmt.Errorf("insert lock: %w", err)
		}
		return nil
	})
	if err != nil {
		return Lock{}, err
	}
	return toLock(row), nil
}

// Lock reads one of the caller's locks.
func (s *Service) Lock(ctx context.Context, id uuid.UUID) (Lock, error) {
	p, err := principal(ctx)
	if err != nil {
		return Lock{}, err
	}
	row, err := s.q.GetLock(ctx, savingsdb.GetLockParams{ID: id, UserID: p.UserID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Lock{}, ErrLockNotFound
	}
	if err != nil {
		return Lock{}, fmt.Errorf("load lock: %w", err)
	}
	return toLock(row), nil
}

// Locks lists the caller's locks, running ones first.
func (s *Service) Locks(ctx context.Context) ([]Lock, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListLocks(ctx, p.UserID)
	if err != nil {
		return nil, fmt.Errorf("list locks: %w", err)
	}
	out := make([]Lock, len(rows))
	for i, r := range rows {
		out[i] = toLock(r)
	}
	return out, nil
}

// BreakLock ends a lock early: the principal comes back whole, plus the share of the
// interest earned so far that the disclosed penalty leaves. A lock that has already ended
// (or reached its maturity day) is returned as it is paid, so a retry or a late tap never
// charges a penalty it should not.
func (s *Service) BreakLock(ctx context.Context, id uuid.UUID) (Lock, error) {
	p, err := principal(ctx)
	if err != nil {
		return Lock{}, err
	}
	if _, err := s.Lock(ctx, id); err != nil {
		return Lock{}, err
	}
	home, err := s.accounts.Naira(ctx, p.UserID)
	if err != nil {
		return Lock{}, err
	}
	today := lagosDay(s.now())
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		l, err := savingsdb.New(tx).LockLock(ctx, id)
		if err != nil {
			return fmt.Errorf("lock lock: %w", err)
		}
		if l.Status != "active" {
			return nil
		}
		if l, err = s.accrue(ctx, tx, l, today); err != nil {
			return err
		}
		_, err = s.settleLock(ctx, tx, l, home.AccountID, today.Before(l.MaturityDate))
		return err
	})
	if err != nil {
		return Lock{}, err
	}
	return s.Lock(ctx, id)
}
