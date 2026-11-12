package demo

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/audit"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// maxOffsetDays is as far ahead as one demo customer can take their clock (the longest lock).
const maxOffsetDays = 365

// Advancer brings one customer's own records up to a date, as the background sweeps would have
// done on the days in between. Savings, credit, scheduled transfers and ajo implement it.
type Advancer interface {
	AdvanceUser(ctx context.Context, userID uuid.UUID, asOf time.Time) error
}

// Clock is a demo customer's view of today.
type Clock struct {
	Now        time.Time
	OffsetDays int
}

// TimeTravel moves the caller's demo clock forward by days and runs what fell due on the way:
// goal interest and locks, scheduled transfers, loan instalments and ajo cycles. The real clock
// and everyone else are untouched; the ledger keeps its real timestamps, so the customer sees
// the effects (interest, a matured lock, a paid cycle) arrive at once.
func (s *Service) TimeTravel(ctx context.Context, days int) (Clock, error) {
	p, _, err := s.caller(ctx)
	if err != nil {
		return Clock{}, err
	}
	if days < 1 || days > maxOffsetDays {
		return Clock{}, problem.Validation(problem.Field("/days", "invalid", "Choose between 1 and 365 days."))
	}
	var offset int
	if err := s.pool.QueryRow(ctx, `SELECT demo_offset_days FROM users WHERE id = $1`, p.UserID).Scan(&offset); err != nil {
		return Clock{}, fmt.Errorf("read demo clock: %w", err)
	}
	if offset+days > maxOffsetDays {
		return Clock{}, problem.Validation(problem.Field("/days", "too_far", fmt.Sprintf("The demo clock can go %d more days ahead. Reset the demo to start again.", maxOffsetDays-offset)))
	}
	offset += days
	asOf := s.now().AddDate(0, 0, offset)
	for _, a := range s.advancers {
		if err := a.AdvanceUser(ctx, p.UserID, asOf); err != nil {
			return Clock{}, fmt.Errorf("demo time travel: %w", err)
		}
	}
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE users SET demo_offset_days = $2 WHERE id = $1`, p.UserID, offset); err != nil {
			return fmt.Errorf("save demo clock: %w", err)
		}
		_, err := audit.Append(ctx, tx, audit.Input{
			Actor: audit.Customer(p.UserID), Action: "demo.time_travel", ResourceType: "user", ResourceID: p.UserID.String(),
			Metadata: map[string]any{"days": days, "offset_days": offset},
		}, s.now())
		return err
	})
	if err != nil {
		return Clock{}, err
	}
	return Clock{Now: asOf.UTC(), OffsetDays: offset}, nil
}
