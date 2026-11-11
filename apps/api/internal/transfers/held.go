package transfers

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers/transfersdb"
)

// errNotHeld answers a decision on a transfer nobody is holding for review any more (another
// reviewer got there first, or the customer cancelled).
var errNotHeld = problem.Conflict("This transfer is no longer waiting for review.")

// StaffView loads any customer's transfer with its timeline, for the fraud case view.
func (s *Service) StaffView(ctx context.Context, id uuid.UUID) (View, error) {
	t, err := s.q.GetTransferByID(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return View{}, ErrTransferNotFound
	}
	if err != nil {
		return View{}, fmt.Errorf("load transfer: %w", err)
	}
	evs, err := s.q.ListTransferEvents(ctx, []uuid.UUID{id})
	if err != nil {
		return View{}, fmt.Errorf("load timeline: %w", err)
	}
	return View{Transfer: t, Timeline: evs}, nil
}

// DecideHeld settles a transfer the risk engine held for a person (ADM-5). Releasing sends it as
// if it had never been held; rejecting gives the money and the day's limit back. record runs in
// the same transaction, so the case file (who, label, note) and the audit entry exist exactly
// when the decision does. A transfer that is not held any more is a 409.
func (s *Service) DecideHeld(ctx context.Context, id uuid.UUID, release bool, record func(ctx context.Context, tx pgx.Tx) error) error {
	pre, err := s.q.GetTransferByID(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrTransferNotFound
	}
	if err != nil {
		return fmt.Errorf("load transfer: %w", err)
	}
	if Status(pre.Status) != HeldForReview {
		return errNotHeld
	}
	land, err := s.landingFor(ctx, pre)
	if err != nil {
		return err
	}
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		t, err := q.LockTransfer(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTransferNotFound
		}
		if err != nil {
			return fmt.Errorf("lock transfer: %w", err)
		}
		if Status(t.Status) != HeldForReview {
			return errNotHeld
		}
		if release {
			if err := event(ctx, q, id, "released", "Cleared by a reviewer", nil); err != nil {
				return err
			}
			sp, err := tx.Begin(ctx)
			if err != nil {
				return fmt.Errorf("savepoint: %w", err)
			}
			err = s.proceed(ctx, sp, t, land)
			var p *problem.Error
			if err != nil && errors.As(err, &p) {
				// It cannot go (the receiver reached their balance cap meanwhile): give the money
				// back instead of leaving the reviewer's decision half done.
				if rerr := sp.Rollback(ctx); rerr != nil {
					return fmt.Errorf("rollback to savepoint: %w", rerr)
				}
				detail := p.Title
				if err := s.reject(ctx, tx, t, "Could not be sent after review", &detail); err != nil {
					return err
				}
			} else if err != nil {
				return err
			} else if err := sp.Commit(ctx); err != nil {
				return fmt.Errorf("release savepoint: %w", err)
			}
		} else if err := s.reject(ctx, tx, t, "Not approved after review", nil); err != nil {
			return err
		}
		return record(ctx, tx)
	})
}

// reject ends a held transfer for good: the hold and the day's limit go back to the customer.
func (s *Service) reject(ctx context.Context, tx pgx.Tx, t transfersdb.Transfer, label string, detail *string) error {
	if t.HoldID != nil {
		if err := ledger.ReleaseHold(ctx, tx, *t.HoldID); err != nil {
			return fmt.Errorf("release transfer hold: %w", err)
		}
	}
	if err := s.releaseLimit(ctx, tx, t); err != nil {
		return err
	}
	if _, err := s.move(ctx, s.q.WithTx(tx), t, Rejected, label, detail, nil); err != nil {
		return err
	}
	_, err := accounts.Settle(ctx, tx, t.TransactionID, "failed", nil, t.SourceAccountID)
	return err
}
