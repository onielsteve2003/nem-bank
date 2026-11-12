package cards

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/cards/cardsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// Update is a change to a card's controls (CARD-4). Nil leaves a control alone. The
// Clear flags remove a spend limit, a merchant lock or the nickname.
type Update struct {
	Nickname      *string
	SpendLimit    *SpendLimit
	ClearLimit    bool
	Online        *bool
	International *bool
	MerchantLock  *MerchantLock
	ClearLock     bool
}

func live(c cardsdb.Card) bool { return c.Status == StatusActive || c.Status == StatusFrozen }

// lockOwned locks the caller's card for a change, so it cannot change under a charge being
// decided on it. Every writer locks the card before anything else, then the account: the
// same order the authorization engine uses, so the two cannot deadlock.
func (s *Service) lockOwned(ctx context.Context, tx pgx.Tx, userID, id uuid.UUID) (cardsdb.Card, error) {
	card, err := s.q.WithTx(tx).LockCard(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && card.UserID != userID) {
		return cardsdb.Card{}, ErrCardNotFound
	}
	if err != nil {
		return cardsdb.Card{}, fmt.Errorf("lock card: %w", err)
	}
	return card, nil
}

func (s *Service) principal(ctx context.Context) (identity.Principal, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return identity.Principal{}, problem.Unauthorized()
	}
	return p, nil
}

// UpdateControls changes a card's limits, channels, merchant lock and nickname.
func (s *Service) UpdateControls(ctx context.Context, id uuid.UUID, u Update) (cardsdb.Card, error) {
	p, err := s.principal(ctx)
	if err != nil {
		return cardsdb.Card{}, err
	}
	current, err := s.Get(ctx, id) // for the currency; the locked row below is what is changed
	if err != nil {
		return cardsdb.Card{}, err
	}
	if err := checkLimit(u.SpendLimit, current.Currency); err != nil {
		return cardsdb.Card{}, err
	}
	var nickname *string
	if u.Nickname != nil {
		if nickname, err = cleanNickname(*u.Nickname); err != nil {
			return cardsdb.Card{}, err
		}
	}
	var out cardsdb.Card
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		card, err := s.lockOwned(ctx, tx, p.UserID, id)
		if err != nil {
			return err
		}
		if !live(card) {
			return errNotLive
		}
		arg := cardsdb.UpdateCardControlsParams{
			ID: id, Nickname: card.Nickname, SpendLimitMinor: card.SpendLimitMinor, SpendLimitPeriod: card.SpendLimitPeriod,
			OnlineEnabled: card.OnlineEnabled, InternationalEnabled: card.InternationalEnabled,
			MerchantID: card.MerchantID, MerchantName: card.MerchantName,
		}
		if u.Nickname != nil {
			arg.Nickname = nickname
		}
		switch {
		case u.ClearLimit:
			arg.SpendLimitMinor, arg.SpendLimitPeriod = nil, nil
		case u.SpendLimit != nil:
			minor, period := u.SpendLimit.Amount.Amount(), u.SpendLimit.Period
			arg.SpendLimitMinor, arg.SpendLimitPeriod = &minor, &period
		}
		switch {
		case u.ClearLock:
			arg.MerchantID, arg.MerchantName = nil, nil
		case u.MerchantLock != nil:
			arg.MerchantID, arg.MerchantName = &u.MerchantLock.ID, &u.MerchantLock.Name
		}
		if u.Online != nil {
			arg.OnlineEnabled = *u.Online
		}
		if u.International != nil {
			arg.InternationalEnabled = *u.International
		}
		// A merchant-locked card with its lock removed would be an ordinary card under a
		// misleading type, so the lock cannot come off one.
		if card.Type == TypeMerchantLocked && arg.MerchantID == nil {
			return errNeedLock
		}
		out, err = s.q.WithTx(tx).UpdateCardControls(ctx, arg)
		if err != nil {
			return fmt.Errorf("update card controls: %w", err)
		}
		return nil
	})
	return out, err
}

// setStatus moves a locked card to a new status.
func (s *Service) setStatus(ctx context.Context, tx pgx.Tx, card cardsdb.Card, status string, byPanic bool) (cardsdb.Card, error) {
	arg := cardsdb.SetCardStatusParams{ID: card.ID, Status: status, FrozenByPanic: byPanic}
	if status == StatusTerminated {
		t := s.now().UTC()
		arg.TerminatedAt = &t
	}
	out, err := s.q.WithTx(tx).SetCardStatus(ctx, arg)
	if err != nil {
		return cardsdb.Card{}, fmt.Errorf("set card %s %s: %w", card.ID, status, err)
	}
	return out, nil
}

// Freeze stops new charges until the customer unfreezes (CARD-4). Freezing a frozen card
// changes nothing.
func (s *Service) Freeze(ctx context.Context, id uuid.UUID) (cardsdb.Card, error) {
	p, err := s.principal(ctx)
	if err != nil {
		return cardsdb.Card{}, err
	}
	var out cardsdb.Card
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		card, err := s.lockOwned(ctx, tx, p.UserID, id)
		if err != nil {
			return err
		}
		switch {
		case card.Status == StatusFrozen:
			out = card
			return nil
		case card.Status != StatusActive:
			return errNotLive
		}
		out, err = s.setStatus(ctx, tx, card, StatusFrozen, false)
		return err
	})
	return out, err
}

// Unfreeze lets a frozen card be charged again. A card the panic button froze needs a fresh
// step-up (SEC-4), spent in the same transaction.
func (s *Service) Unfreeze(ctx context.Context, id uuid.UUID, stepUpToken string) (cardsdb.Card, error) {
	p, err := s.principal(ctx)
	if err != nil {
		return cardsdb.Card{}, err
	}
	var out cardsdb.Card
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		card, err := s.lockOwned(ctx, tx, p.UserID, id)
		if err != nil {
			return err
		}
		switch {
		case card.Status == StatusActive:
			out = card
			return nil
		case card.Status != StatusFrozen:
			return errNotLive
		}
		if card.FrozenByPanic {
			// While panic mode is on its cards stay frozen: releasing the button unfreezes
			// them all at once.
			if at, err := s.q.WithTx(tx).GetPanicAt(ctx, p.UserID); err != nil {
				return fmt.Errorf("load panic state: %w", err)
			} else if at != nil {
				return errPanicOn
			}
			if err := s.stepUps.ConsumeStepUp(ctx, tx, p.UserID, StepUpUnfreeze, stepUpToken); err != nil {
				return err
			}
		}
		out, err = s.setStatus(ctx, tx, card, StatusActive, false)
		return err
	})
	return out, err
}

// Terminate closes a card for good (CARD-6). Authorizations already made still settle.
// Terminating a terminated card changes nothing.
func (s *Service) Terminate(ctx context.Context, id uuid.UUID) (cardsdb.Card, error) {
	p, err := s.principal(ctx)
	if err != nil {
		return cardsdb.Card{}, err
	}
	var out cardsdb.Card
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		card, err := s.lockOwned(ctx, tx, p.UserID, id)
		if err != nil {
			return err
		}
		if card.Status == StatusTerminated {
			out = card
			return nil
		}
		out, err = s.setStatus(ctx, tx, card, StatusTerminated, false)
		return err
	})
	return out, err
}

// Replace ends a card and issues a new number with the same controls (CARD-6), in one
// transaction: the customer is never left with both, or with neither.
func (s *Service) Replace(ctx context.Context, id uuid.UUID) (cardsdb.Card, error) {
	p, err := s.principal(ctx)
	if err != nil {
		return cardsdb.Card{}, err
	}
	old, err := s.Get(ctx, id)
	if err != nil {
		return cardsdb.Card{}, err
	}
	if !live(old) {
		return cardsdb.Card{}, errNotLive
	}
	req := IssueRequest{AccountID: old.AccountID, Type: old.Type, Design: old.Design}
	if old.Nickname != nil {
		req.Nickname = *old.Nickname
	}
	if old.SpendLimitMinor != nil {
		req.SpendLimit = &SpendLimit{Amount: moneyOf(*old.SpendLimitMinor, old.Currency), Period: *old.SpendLimitPeriod}
	}
	if old.MerchantID != nil {
		req.MerchantLock = &MerchantLock{ID: *old.MerchantID, Name: *old.MerchantName}
	}
	pl, err := s.prepare(ctx, p.UserID, req)
	if err != nil {
		return cardsdb.Card{}, err
	}
	pl.online, pl.international = old.OnlineEnabled, old.InternationalEnabled
	var out cardsdb.Card
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		locked, err := s.lockOwned(ctx, tx, p.UserID, id)
		if err != nil {
			return err
		}
		if !live(locked) {
			return errNotLive
		}
		if _, err := s.setStatus(ctx, tx, locked, StatusTerminated, false); err != nil {
			return err
		}
		out, err = s.insert(ctx, tx, pl)
		return err
	})
	return out, err
}
