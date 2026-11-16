package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/cards"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers"
)

// Executor runs what the customer confirmed, through the same services the app calls directly,
// so every limit, fee, risk check and cooling-off applies exactly as for a payment made by hand.
type Executor interface {
	// Transfer sends the drafted transfer and returns the new transfer's ID.
	Transfer(ctx context.Context, body api.CreateTransferRequest) (uuid.UUID, error)
	// FreezeCard freezes the card.
	FreezeCard(ctx context.Context, id uuid.UUID) error
}

// ExecutorFrom adapts the transfers and cards services.
func ExecutorFrom(t *transfers.Service, c *cards.Service) Executor { return executor{t, c} }

type executor struct {
	t *transfers.Service
	c *cards.Service
}

func (e executor) Transfer(ctx context.Context, b api.CreateTransferRequest) (uuid.UUID, error) {
	amount, err := money.ParseMinor(b.Amount.AmountMinor, string(b.Amount.Currency))
	if err != nil {
		return uuid.Nil, problem.Validation(problem.Field("/amount", "invalid", "The amount is not valid."))
	}
	r := transfers.Request{SourceAccountID: b.SourceAccountId, Destination: b.Destination, Amount: amount}
	if b.SaveBeneficiary != nil {
		r.SaveBeneficiary = *b.SaveBeneficiary
	}
	if b.Narration != nil {
		r.Narration = *b.Narration
	}
	if b.Category != nil {
		c := string(*b.Category)
		r.Category = &c
	}
	v, err := e.t.Create(ctx, r)
	if err != nil {
		return uuid.Nil, err
	}
	return v.ID, nil
}

func (e executor) FreezeCard(ctx context.Context, id uuid.UUID) error {
	_, err := e.c.Freeze(ctx, id)
	return err
}

var (
	errActionState = func(status api.PreparedActionStatus) *problem.Error {
		return problem.New(http.StatusConflict, problem.CodeConflict, "This action is already "+string(status)+".")
	}
	errActionKind = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "The assistant cannot run this kind of action yet").
			WithDetail("Do it yourself from the app instead.")
)

// Confirm runs a prepared action once the customer approves it (the request already carries the
// device signature). The action is claimed first, so confirming twice, or from two devices at
// the same moment, runs it once; a second confirmation sees it already confirmed.
func (s *Service) Confirm(ctx context.Context, id uuid.UUID) (api.PreparedAction, error) {
	p, err := caller(ctx)
	if err != nil {
		return api.PreparedAction{}, err
	}
	if s.exec == nil || s.pool == nil {
		return api.PreparedAction{}, errUnavailable
	}
	a, err := s.loadAction(ctx, p.UserID, id)
	if err != nil {
		return a, err
	}
	if a.Status != api.PreparedActionStatus("prepared") {
		return a, errActionState(a.Status)
	}
	if a.Kind != api.PreparedActionKind("transfer") && a.Kind != api.PreparedActionKind("card_freeze") {
		return a, errActionKind
	}
	tag, err := s.pool.Exec(ctx, `UPDATE prepared_actions SET status = 'confirmed', updated_at = $3 WHERE id = $1 AND user_id = $2 AND status = 'prepared' AND expires_at > $3`,
		id, p.UserID, s.now())
	if err != nil {
		return a, fmt.Errorf("claim action: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return s.loadAndRefuse(ctx, p.UserID, id)
	}
	resource, resourceID, runErr := s.run(ctx, a)
	if runErr != nil {
		// Nothing was done: say so on the card, and let the customer see why.
		if _, err := s.pool.Exec(ctx, `UPDATE prepared_actions SET status = 'failed', updated_at = $2 WHERE id = $1`, id, s.now()); err != nil {
			s.log.ErrorContext(ctx, "mark action failed", "action_id", id.String(), "error", err)
		}
		return api.PreparedAction{}, runErr
	}
	result, err := json.Marshal(map[string]any{"resource": resource, "id": resourceID})
	if err != nil {
		return a, fmt.Errorf("encode result: %w", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE prepared_actions SET result = $2, updated_at = $3 WHERE id = $1`, id, result, s.now()); err != nil {
		return a, fmt.Errorf("save result: %w", err)
	}
	return s.loadAction(ctx, p.UserID, id)
}

// loadAndRefuse answers a claim that lost: someone confirmed, discarded or let it expire first.
func (s *Service) loadAndRefuse(ctx context.Context, userID, id uuid.UUID) (api.PreparedAction, error) {
	a, err := s.loadAction(ctx, userID, id)
	if err != nil {
		return a, err
	}
	status := a.Status
	if status == api.PreparedActionStatus("prepared") {
		status = api.PreparedActionStatus("expired")
	}
	return a, errActionState(status)
}

// run does what the action says. The details are the exact request the card showed.
func (s *Service) run(ctx context.Context, a api.PreparedAction) (resource string, id uuid.UUID, err error) {
	raw, err := json.Marshal(a.Details)
	if err != nil {
		return "", uuid.Nil, fmt.Errorf("encode details: %w", err)
	}
	switch a.Kind {
	case api.PreparedActionKind("transfer"):
		var body api.CreateTransferRequest
		if err := json.Unmarshal(raw, &body); err != nil {
			return "", uuid.Nil, fmt.Errorf("decode transfer details: %w", err)
		}
		id, err = s.exec.Transfer(ctx, body)
		return "transfer", id, err
	default: // card_freeze
		var body struct {
			CardID uuid.UUID `json:"card_id"`
		}
		if err := json.Unmarshal(raw, &body); err != nil || body.CardID == uuid.Nil {
			return "", uuid.Nil, errors.Join(errActionKind, err)
		}
		return "card", body.CardID, s.exec.FreezeCard(ctx, body.CardID)
	}
}
