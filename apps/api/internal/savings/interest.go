package savings

import (
	"context"

	"fmt"
	"log/slog"
	"math/big"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/savings/savingsdb"
)

// Interest events, for notifications (T30) to word.
const (
	TopicLockMatured = "savings.lock_matured"
	TopicLockBroken  = "savings.lock_broken"
)

// bpsYear is the divisor of simple interest at an annual rate in basis points over a
// 365-day year: rate/10,000 per year, per day /365.
const bpsYear = 10_000 * 365

// SimpleInterest is the interest on principal kobo at rateBps a year for days days, rounded
// down: the customer is never paid a fraction of a kobo they did not earn. It is computed
// in big integers, so no principal, rate or term can overflow.
func SimpleInterest(principal int64, rateBps, days int) int64 {
	if principal <= 0 || rateBps <= 0 || days <= 0 {
		return 0
	}
	n := new(big.Int).Mul(big.NewInt(principal), big.NewInt(int64(rateBps)))
	n.Mul(n, big.NewInt(int64(days)))
	n.Div(n, big.NewInt(bpsYear))
	return n.Int64() // principal*rate*days/bpsYear < principal for any rate under 10,000 bps a day
}

// daysBetween counts whole days from a to b, both midnight-UTC dates.
func daysBetween(a, b time.Time) int { return int(b.Sub(a) / (24 * time.Hour)) }

// SweepGoalInterest pays every open goal the interest it earned since interest was last
// paid (SAV-5). It returns how many goals were paid. Interest is on the balance at the
// moment of payment: the sweep runs every few minutes, so a goal is normally paid for the
// one day just ended, and a catch-up after an outage uses the current balance.
func (s *Service) SweepGoalInterest(ctx context.Context) (paid int, err error) {
	today := lagosDay(s.now())
	ids, err := s.q.ListGoalsToPay(ctx, today)
	if err != nil {
		return 0, fmt.Errorf("list goals owed interest: %w", err)
	}
	for _, id := range ids {
		ok, err := s.payGoalInterest(ctx, id, today)
		if err != nil {
			s.log.Warn("goal interest", slog.String("goal_id", id.String()), slog.Any("error", err))
			continue
		}
		if ok {
			paid++
		}
	}
	return paid, nil
}

// payGoalInterest posts one goal's interest from the bank's interest expense into the goal,
// under the goal's row lock. A goal that earned nothing (empty, or a fraction of a kobo)
// still moves its date forward, so it is not looked at again until tomorrow.
func (s *Service) payGoalInterest(ctx context.Context, id uuid.UUID, today time.Time) (bool, error) {
	var paid bool
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := savingsdb.New(tx)
		g, err := q.LockGoal(ctx, id)
		if err != nil {
			return fmt.Errorf("lock goal: %w", err)
		}
		if g.Status != "active" || !g.InterestPaidTo.Before(today) {
			return nil
		}
		bal, err := ledger.GetBalances(ctx, tx, g.AccountID)
		if err != nil {
			return fmt.Errorf("goal balance: %w", err)
		}
		interest := SimpleInterest(bal.Ledger.Amount(), int(g.InterestRateBps), daysBetween(g.InterestPaidTo, today))
		if interest > 0 {
			expense, err := ledger.SystemAccount(ctx, tx, ledger.KindInterestExpense, "NGN")
			if err != nil {
				return err
			}
			if _, err := ledger.Post(ctx, tx, ledger.Entry{
				Kind: "interest_accrual", Reference: reference("INT", g.ID), IdempotencyKey: fmt.Sprintf("goal-interest:%s:%s", g.ID, g.InterestPaidTo.Format(time.DateOnly)),
				Metadata: map[string]any{"goal_id": g.ID.String(), "to": today.Format(time.DateOnly)},
				Legs:     []ledger.Leg{ledger.Debit(expense.ID, naira(interest)), ledger.Credit(g.AccountID, naira(interest))},
			}); err != nil {
				return err
			}
			paid = true
		}
		return q.SetGoalInterest(ctx, savingsdb.SetGoalInterestParams{ID: id, PaidMinor: interest, PaidTo: today})
	})
	return paid, err
}

// SweepLocks posts the interest owed on running locks and pays out the ones that reached
// maturity (SAV-4, SAV-5). It returns how many locks were paid out.
func (s *Service) SweepLocks(ctx context.Context) (matured int, err error) {
	today := lagosDay(s.now())
	ids, err := s.q.ListLocksToAdvance(ctx, today)
	if err != nil {
		return 0, fmt.Errorf("list locks to advance: %w", err)
	}
	for _, id := range ids {
		ended, err := s.advanceLock(ctx, id, today)
		if err != nil {
			s.log.Warn("advance lock", slog.String("lock_id", id.String()), slog.Any("error", err))
			continue
		}
		if ended {
			matured++
		}
	}
	return matured, nil
}

// advanceLock brings one lock up to today and, if it reached maturity, pays it out.
func (s *Service) advanceLock(ctx context.Context, id uuid.UUID, today time.Time) (bool, error) {
	owner, err := s.q.GetLockOwner(ctx, id)
	if err != nil {
		return false, fmt.Errorf("load lock owner: %w", err)
	}
	// Read through the pool before the transaction opens, as the other money paths do.
	home, err := s.accounts.Naira(ctx, owner)
	if err != nil {
		return false, err
	}
	var ended bool
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := savingsdb.New(tx)
		l, err := q.LockLock(ctx, id)
		if err != nil {
			return fmt.Errorf("lock lock: %w", err)
		}
		if l.Status != "active" {
			return nil
		}
		if l, err = s.accrue(ctx, tx, l, today); err != nil {
			return err
		}
		if today.Before(l.MaturityDate) {
			return nil
		}
		ended = true
		_, err = s.settleLock(ctx, tx, l, home.AccountID, false)
		return err
	})
	return ended, err
}

// accrue posts the interest earned up to today into the lock's own account. The total for n
// days is the closed-form figure, and what is posted is the difference from what was
// already posted, so any catch-up lands on exactly the same total as day-by-day would.
func (s *Service) accrue(ctx context.Context, tx pgx.Tx, l savingsdb.LockedSaving, today time.Time) (savingsdb.LockedSaving, error) {
	n := min(int(l.TermDays), daysBetween(l.StartDate, today))
	if n <= int(l.AccruedDays) {
		return l, nil
	}
	total := SimpleInterest(l.PrincipalMinor, int(l.RateBps), n)
	if delta := total - l.AccruedInterestMinor; delta > 0 {
		expense, err := ledger.SystemAccount(ctx, tx, ledger.KindInterestExpense, "NGN")
		if err != nil {
			return l, err
		}
		if _, err := ledger.Post(ctx, tx, ledger.Entry{
			Kind: "interest_accrual", Reference: reference("INT", l.ID), IdempotencyKey: fmt.Sprintf("lock-interest:%s:%d", l.ID, n),
			Metadata: map[string]any{"lock_id": l.ID.String(), "days": n},
			Legs:     []ledger.Leg{ledger.Debit(expense.ID, naira(delta)), ledger.Credit(l.AccountID, naira(delta))},
		}); err != nil {
			return l, err
		}
	}
	if err := savingsdb.New(tx).SetLockAccrual(ctx, savingsdb.SetLockAccrualParams{
		ID: l.ID, AccruedInterestMinor: total, AccruedDays: int32(n), //nolint:gosec // n <= term_days <= 365
	}); err != nil {
		return l, fmt.Errorf("save accrual: %w", err)
	}
	l.AccruedInterestMinor, l.AccruedDays = total, int32(n) //nolint:gosec // as above
	return l, nil
}

// settleLock pays a lock's money to the customer's naira account and ends it. Early means
// the customer broke it before maturity: they keep the principal and the share of the
// interest the penalty leaves, and the forfeited interest goes back to the bank's interest
// expense (the accrual is reversed, so the bank never books interest it did not pay).
func (s *Service) settleLock(ctx context.Context, tx pgx.Tx, l savingsdb.LockedSaving, home uuid.UUID, early bool) (savingsdb.LockedSaving, error) {
	bal, err := ledger.GetBalances(ctx, tx, l.AccountID)
	if err != nil {
		return l, fmt.Errorf("lock balance: %w", err)
	}
	total := bal.Ledger.Amount() // principal plus the interest posted so far
	var forfeited int64
	if early {
		kept := (l.AccruedInterestMinor*(10_000-int64(l.EarlyBreakPenaltyBps)) + 9_999) / 10_000 // rounded up: in the customer's favour
		forfeited = l.AccruedInterestMinor - kept
	}
	paid := total - forfeited
	legs := []ledger.Leg{ledger.Debit(l.AccountID, naira(total)), ledger.Credit(home, naira(paid))}
	if forfeited > 0 {
		expense, err := ledger.SystemAccount(ctx, tx, ledger.KindInterestExpense, "NGN")
		if err != nil {
			return l, err
		}
		legs = append(legs, ledger.Credit(expense.ID, naira(forfeited)))
	}
	ref := reference("LCK", l.ID)
	posted, err := ledger.Post(ctx, tx, ledger.Entry{
		Kind: "savings", Reference: ref, IdempotencyKey: "lock-payout:" + l.ID.String(),
		Metadata: map[string]any{"lock_id": l.ID.String(), "early": early, "forfeited_minor": forfeited}, Legs: legs,
	})
	if err != nil {
		return l, err
	}
	now := s.now().UTC()
	status, narration, topic := "matured", "Locked savings matured", TopicLockMatured
	if early {
		status, narration, topic = "broken", "Broke locked savings", TopicLockBroken
	}
	interestPaid := paid - l.PrincipalMinor
	line := accounts.Line{
		UserID: l.UserID, AccountID: home, Type: "savings", Direction: "credit", Status: "completed",
		Amount: naira(l.PrincipalMinor), Entry: &posted, Narration: narration, Reference: ref, Category: "savings", At: now,
	}
	// The forfeited interest is shown on the line the customer reads: the interest if any
	// was kept, else the principal.
	penalty := naira(forfeited)
	if interestPaid > 0 {
		interest := line
		interest.Type, interest.Amount, interest.Narration = "interest", naira(interestPaid), narration+": interest"
		if forfeited > 0 {
			interest.Fee, interest.FeeCode = &penalty, "early_break_penalty"
		}
		if err := s.record(ctx, tx, interest); err != nil {
			return l, err
		}
	} else if forfeited > 0 {
		line.Fee, line.FeeCode = &penalty, "early_break_penalty"
	}
	if err := s.record(ctx, tx, line); err != nil {
		return l, err
	}
	out, err := savingsdb.New(tx).EndLock(ctx, savingsdb.EndLockParams{ID: l.ID, Status: status, PaidOutMinor: &paid, At: &now})
	if err != nil {
		return l, fmt.Errorf("end lock: %w", err)
	}
	if err := emit(ctx, tx, topic, l.ID, map[string]any{
		"user_id": l.UserID, "lock_id": l.ID, "principal_minor": l.PrincipalMinor, "paid_out_minor": paid, "forfeited_minor": forfeited, "currency": "NGN",
	}); err != nil {
		return l, err
	}
	return out, nil
}
