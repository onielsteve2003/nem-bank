// Package panicmode is the customer's panic button (SEC-4): one call freezes every card and
// blocks outgoing money, with no step-up so it works in a hurry; turning it off needs one.
//
// State is users.panic_at. Other domains read it through identity.CustomerProfile.Panic and
// refuse to send while it is set. Cards the button froze carry cards.frozen_by_panic, so
// releasing it unfreezes exactly those and leaves a card the customer froze themselves alone.
package panicmode

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/audit"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/panicmode/panicdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// Topic is the outbox event written whenever panic mode turns on or off. The realtime
// subscriber and the notifications subscriber both listen to it.
const Topic = "security.panic_changed"

// StepUpPurpose is the step-up that turning panic mode off needs (contract StepUpPurpose).
const StepUpPurpose = "unfreeze"

// StepUps spends the confirmation a customer earned before releasing panic mode.
type StepUps interface {
	ConsumeStepUp(ctx context.Context, tx pgx.Tx, userID uuid.UUID, purpose, token string) error
}

// Config holds the service's dependencies.
type Config struct {
	Pool    *pgxpool.Pool
	StepUps StepUps
	Now     func() time.Time
}

// State is the contract's PanicState.
type State struct {
	Active          bool
	ActivatedAt     *time.Time
	CardsFrozen     int
	OutgoingBlocked bool
}

// Service turns panic mode on and off.
type Service struct {
	pool    *pgxpool.Pool
	q       *panicdb.Queries
	stepUps StepUps
	now     func() time.Time
}

// NewService checks the configuration and returns the service.
func NewService(cfg Config) (*Service, error) {
	if cfg.Pool == nil || cfg.StepUps == nil {
		return nil, errors.New("panicmode: pool and step-ups are required")
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	return &Service{pool: cfg.Pool, q: panicdb.New(cfg.Pool), stepUps: cfg.StepUps, now: now}, nil
}

func principal(ctx context.Context) (identity.Principal, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return identity.Principal{}, problem.Unauthorized()
	}
	return p, nil
}

func (s *Service) state(ctx context.Context, q *panicdb.Queries, userID uuid.UUID) (State, error) {
	at, err := q.GetPanicAt(ctx, userID)
	if err != nil {
		return State{}, fmt.Errorf("load panic state: %w", err)
	}
	n, err := q.CountPanicCards(ctx, userID)
	if err != nil {
		return State{}, fmt.Errorf("count panic cards: %w", err)
	}
	if at == nil {
		return State{}, nil
	}
	return State{Active: true, ActivatedAt: at, CardsFrozen: int(n), OutgoingBlocked: true}, nil
}

// Get returns the caller's panic state.
func (s *Service) Get(ctx context.Context) (State, error) {
	p, err := principal(ctx)
	if err != nil {
		return State{}, err
	}
	return s.state(ctx, s.q, p.UserID)
}

// emit writes the change in the caller's transaction, so it exists exactly when the state
// changed.
func (s *Service) emit(ctx context.Context, tx pgx.Tx, userID uuid.UUID, st State) error {
	payload := map[string]any{
		"user_id": userID, "active": st.Active, "activated_at": st.ActivatedAt,
		"cards_frozen": st.CardsFrozen, "outgoing_blocked": st.OutgoingBlocked,
	}
	if _, err := jobs.Write(ctx, tx, jobs.Event{Topic: Topic, AggregateType: "user", AggregateID: userID.String(), Payload: payload}); err != nil {
		return fmt.Errorf("write %s event: %w", Topic, err)
	}
	return nil
}

func (s *Service) audit(ctx context.Context, tx pgx.Tx, userID uuid.UUID, action string, p identity.Principal, extra map[string]any) error {
	meta := map[string]any{"device_id": p.DeviceID}
	for k, v := range extra {
		meta[k] = v
	}
	_, err := audit.Append(ctx, tx, audit.Input{
		Actor: audit.Customer(userID), Action: action, ResourceType: "user", ResourceID: userID.String(), Metadata: meta,
	}, s.now().UTC())
	return err
}

// Activate presses the button: every active card is frozen and outgoing money stops. Pressing
// it twice changes nothing. It needs no step-up, on purpose: it has to work in a hurry.
func (s *Service) Activate(ctx context.Context) (State, error) {
	p, err := principal(ctx)
	if err != nil {
		return State{}, err
	}
	var out State
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		at, err := q.LockPanicAt(ctx, p.UserID)
		if err != nil {
			return fmt.Errorf("lock user: %w", err)
		}
		if at != nil {
			out, err = s.state(ctx, q, p.UserID)
			return err
		}
		now := s.now().UTC()
		if _, err := q.FreezeCardsForPanic(ctx, p.UserID); err != nil {
			return fmt.Errorf("freeze cards: %w", err)
		}
		if err := q.SetPanicAt(ctx, panicdb.SetPanicAtParams{ID: p.UserID, PanicAt: &now}); err != nil {
			return fmt.Errorf("set panic: %w", err)
		}
		if out, err = s.state(ctx, q, p.UserID); err != nil {
			return err
		}
		if err := s.audit(ctx, tx, p.UserID, "security.panic_on", p, map[string]any{"cards_frozen": out.CardsFrozen}); err != nil {
			return err
		}
		return s.emit(ctx, tx, p.UserID, out)
	})
	return out, err
}

// Release turns panic mode off behind a step-up: outgoing money flows again and the cards the
// button froze are unfrozen. Releasing when it is already off changes nothing and spends no
// step-up.
func (s *Service) Release(ctx context.Context, stepUpToken string) (State, error) {
	p, err := principal(ctx)
	if err != nil {
		return State{}, err
	}
	var out State
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		at, err := q.LockPanicAt(ctx, p.UserID)
		if err != nil {
			return fmt.Errorf("lock user: %w", err)
		}
		if at == nil {
			out = State{}
			return nil
		}
		if err := s.stepUps.ConsumeStepUp(ctx, tx, p.UserID, StepUpPurpose, stepUpToken); err != nil {
			return err
		}
		if err := q.ReleasePanicCards(ctx, p.UserID); err != nil {
			return fmt.Errorf("unfreeze cards: %w", err)
		}
		if err := q.SetPanicAt(ctx, panicdb.SetPanicAtParams{ID: p.UserID}); err != nil {
			return fmt.Errorf("clear panic: %w", err)
		}
		out = State{}
		if err := s.audit(ctx, tx, p.UserID, "security.panic_off", p, nil); err != nil {
			return err
		}
		return s.emit(ctx, tx, p.UserID, out)
	})
	return out, err
}
