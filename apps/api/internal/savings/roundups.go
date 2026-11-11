package savings

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/savings/savingsdb"
)

// Events round-ups listen to. A card spend counts when it settles (what was really
// charged, not a hold that may lapse); a transfer when it completes.
const (
	topicCardSettled      = "card.settled"
	topicTransferComplete = "transfer.completed"
)

// RoundUpSettings is the customer's round-up rule (contract RoundUpSettings).
type RoundUpSettings struct {
	Enabled bool
	// RoundTo is the step in kobo: 10000, 50000 or 100000 (₦100, ₦500, ₦1,000).
	RoundTo int64
	GoalID  *uuid.UUID
	Sources []string
}

var defaultRoundUps = RoundUpSettings{RoundTo: 10_000, Sources: []string{"card", "transfer"}}

// RoundUpOf is what a spend rounds up by: the gap to the next multiple of step, and
// nothing when the spend is already round.
func RoundUpOf(spend, step int64) int64 {
	if step <= 0 || spend <= 0 {
		return 0
	}
	if rest := spend % step; rest != 0 {
		return step - rest
	}
	return 0
}

// RoundUps reads the caller's rule; a customer who never set one gets the default (off).
func (s *Service) RoundUps(ctx context.Context) (RoundUpSettings, error) {
	p, err := principal(ctx)
	if err != nil {
		return RoundUpSettings{}, err
	}
	row, err := s.q.GetRoundUpSettings(ctx, p.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return defaultRoundUps, nil
	}
	if err != nil {
		return RoundUpSettings{}, fmt.Errorf("load round-ups: %w", err)
	}
	return RoundUpSettings{Enabled: row.Enabled, RoundTo: row.RoundToMinor, GoalID: row.GoalID, Sources: row.Sources}, nil
}

// SetRoundUps saves the caller's rule (SAV-3). Switching round-ups on starts counting from
// now: spending before that is never rounded up after the fact.
func (s *Service) SetRoundUps(ctx context.Context, in RoundUpSettings) (RoundUpSettings, error) {
	p, err := principal(ctx)
	if err != nil {
		return RoundUpSettings{}, err
	}
	if !slices.Contains([]int64{10_000, 50_000, 100_000}, in.RoundTo) {
		return RoundUpSettings{}, problem.Validation(problem.Field("/round_to", "invalid", "Round up to ₦100, ₦500 or ₦1,000."))
	}
	sources := slices.Clone(in.Sources)
	slices.Sort(sources)
	sources = slices.Compact(sources)
	for _, src := range sources {
		if src != "card" && src != "transfer" {
			return RoundUpSettings{}, problem.Validation(problem.Field("/sources", "invalid", "Round up card or transfer spending."))
		}
	}
	if in.Enabled && len(sources) == 0 {
		return RoundUpSettings{}, problem.Validation(problem.Field("/sources", "required", "Pick what to round up."))
	}
	if in.Enabled && in.GoalID == nil {
		return RoundUpSettings{}, problem.New(422, problem.CodeValidationFailed, "Pick a goal for your round-ups")
	}
	if in.GoalID != nil {
		g, err := s.Get(ctx, *in.GoalID)
		if err != nil {
			return RoundUpSettings{}, err
		}
		if g.Status == "closed" {
			return RoundUpSettings{}, errGoalClosed
		}
	}
	now := s.now().UTC()
	var out RoundUpSettings
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := savingsdb.New(tx)
		prev, err := q.GetRoundUpSettings(ctx, p.UserID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("load round-ups: %w", err)
		}
		params := savingsdb.UpsertRoundUpSettingsParams{
			UserID: p.UserID, Enabled: in.Enabled, RoundToMinor: in.RoundTo, GoalID: in.GoalID, Sources: sources, UpdatedAt: now,
		}
		switch {
		case !in.Enabled:
		case err == nil && prev.Enabled && prev.EnabledSince != nil:
			params.EnabledSince = prev.EnabledSince
		default:
			params.EnabledSince = &now
		}
		row, err := q.UpsertRoundUpSettings(ctx, params)
		if err != nil {
			return fmt.Errorf("save round-ups: %w", err)
		}
		out = RoundUpSettings{Enabled: row.Enabled, RoundTo: row.RoundToMinor, GoalID: row.GoalID, Sources: row.Sources}
		return nil
	})
	return out, err
}

// spend is one settled outgoing payment a round-up may follow.
type spend struct {
	userID  uuid.UUID
	account uuid.UUID
	amount  money.Money
	ref     string
	source  string
	label   string
	at      time.Time
}

// Subscriber turns settled card spends and completed transfers into round-ups (SAV-3).
// It reads the events' JSON, not the cards or transfers packages, so the domains stay
// apart and the event is the contract between them.
func (s *Service) Subscriber() jobs.Subscriber {
	return jobs.Subscriber{
		Name:   "savings_round_ups",
		Topics: []string{topicCardSettled, topicTransferComplete},
		Handle: func(ctx context.Context, d jobs.Delivery) error {
			sp, ok, err := parseSpend(d)
			if err != nil || !ok {
				return err
			}
			return s.roundUp(ctx, sp)
		},
	}
}

func parseSpend(d jobs.Delivery) (spend, bool, error) {
	switch d.Topic {
	case topicCardSettled:
		var e struct {
			UserID          uuid.UUID `json:"user_id"`
			AccountID       uuid.UUID `json:"account_id"`
			AuthorizationID uuid.UUID `json:"authorization_id"`
			MerchantName    string    `json:"merchant_name"`
			BillingMinor    int64     `json:"billing_minor"`
			BillingCurrency string    `json:"billing_currency"`
		}
		if err := json.Unmarshal(d.Payload, &e); err != nil {
			return spend{}, false, fmt.Errorf("card event payload: %w", err)
		}
		// Only naira spending rounds up to a naira goal.
		if e.BillingCurrency != string(money.NGN) {
			return spend{}, false, nil
		}
		return spend{userID: e.UserID, account: e.AccountID, amount: naira(e.BillingMinor), ref: "card:" + e.AuthorizationID.String(),
			source: "card", label: e.MerchantName, at: d.CreatedAt}, true, nil
	case topicTransferComplete:
		var e struct {
			TransferID      uuid.UUID `json:"transfer_id"`
			UserID          uuid.UUID `json:"user_id"`
			SourceAccountID uuid.UUID `json:"source_account_id"`
			AmountMinor     int64     `json:"amount_minor"`
			Currency        string    `json:"currency"`
		}
		if err := json.Unmarshal(d.Payload, &e); err != nil {
			return spend{}, false, fmt.Errorf("transfer event payload: %w", err)
		}
		if e.Currency != string(money.NGN) || e.SourceAccountID == uuid.Nil {
			return spend{}, false, nil
		}
		return spend{userID: e.UserID, account: e.SourceAccountID, amount: naira(e.AmountMinor), ref: "transfer:" + e.TransferID.String(),
			source: "transfer", label: "transfer", at: d.CreatedAt}, true, nil
	}
	return spend{}, false, nil
}

// roundUp takes the round-up for one spend. Every way of not doing it (rule off, wrong
// source, spend already round, goal gone, not enough left in the account) is a quiet
// no-op: a round-up must never fail or hold up the payment it follows.
func (s *Service) roundUp(ctx context.Context, sp spend) error {
	rule, err := s.q.GetRoundUpSettings(ctx, sp.userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load round-ups: %w", err)
	}
	if !rule.Enabled || rule.GoalID == nil || rule.EnabledSince == nil || sp.at.Before(*rule.EnabledSince) || !slices.Contains(rule.Sources, sp.source) {
		return nil
	}
	extra := RoundUpOf(sp.amount.Amount(), rule.RoundToMinor)
	if extra == 0 {
		return nil
	}
	amount := naira(extra)
	lineID, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("round-up id: %w", err)
	}
	now := s.now().UTC()
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := savingsdb.New(tx)
		g, err := q.LockGoal(ctx, *rule.GoalID)
		if err != nil {
			return fmt.Errorf("lock goal: %w", err)
		}
		if g.Status != "active" || g.UserID != sp.userID {
			return nil
		}
		ref := reference("RUP", lineID)
		posted, err := ledger.Post(ctx, tx, ledger.Entry{
			Kind: "savings", Reference: ref, IdempotencyKey: "roundup:" + sp.ref,
			Metadata: map[string]any{"goal_id": g.ID.String(), "round_up_of": sp.ref},
			Legs:     []ledger.Leg{ledger.Debit(sp.account, amount), ledger.Credit(g.AccountID, amount)},
		})
		if errors.Is(err, ledger.ErrDuplicateEntry) {
			return nil // this spend was rounded up already
		}
		if err != nil {
			return err
		}
		if _, err := q.InsertRoundUp(ctx, savingsdb.InsertRoundUpParams{
			ID: lineID, UserID: sp.userID, GoalID: g.ID, SourceRef: sp.ref, AmountMinor: extra, EntryID: posted.EntryID, CreatedAt: now,
		}); err != nil {
			return fmt.Errorf("insert round-up: %w", err)
		}
		return s.record(ctx, tx, accounts.Line{
			ID: lineID, UserID: sp.userID, AccountID: sp.account, Type: "savings", Direction: "debit", Status: "completed",
			Amount: amount, Entry: &posted, Narration: "Round-up: " + sp.label, Reference: ref, Category: "savings", At: now,
		})
	})
	if errors.Is(err, ledger.ErrInsufficientFunds) {
		return nil
	}
	return err
}
