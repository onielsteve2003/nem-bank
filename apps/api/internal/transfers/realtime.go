package transfers

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/realtime"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers/transfersdb"
)

// RealtimeSubscriber pushes transfer and money-request events to the people they concern:
// the sender sees the transfer move and their balance change, a Nem recipient sees their
// balance change, and a payer sees the request arrive (TRF-7, REQ-1).
func (s *Service) RealtimeSubscriber(hub *realtime.Hub) jobs.Subscriber {
	return jobs.Subscriber{
		Name:   "realtime_transfers",
		Topics: []string{"transfer.completed", "transfer.failed", "money_request.created"},
		Handle: func(ctx context.Context, d jobs.Delivery) error {
			if d.Topic == "money_request.created" {
				return s.pushRequest(ctx, hub, d)
			}
			return s.pushTransfer(ctx, hub, d)
		},
	}
}

// eventID derives a distinct, stable ID per message from the outbox event's, so one outbox
// event that becomes several messages for one person never repeats an ID.
func eventID(d jobs.Delivery, kind string) uuid.UUID { return uuid.NewSHA1(d.ID, []byte(kind)) }

func (s *Service) pushTransfer(ctx context.Context, hub *realtime.Hub, d jobs.Delivery) error {
	var p struct {
		TransferID  uuid.UUID `json:"transfer_id"`
		UserID      uuid.UUID `json:"user_id"`
		RecipientID uuid.UUID `json:"recipient_user_id"`
	}
	if err := json.Unmarshal(d.Payload, &p); err != nil {
		return fmt.Errorf("transfer event payload: %w", err)
	}
	v, err := s.view(ctx, p.UserID, p.TransferID)
	if err != nil {
		return err
	}
	tj, err := TransferJSON(v)
	if err != nil {
		return err
	}
	if err := hub.Publish(p.UserID, realtime.Event{ID: eventID(d, "transfer.updated"), Type: "transfer.updated", OccurredAt: d.CreatedAt.UTC(), Data: tj}); err != nil {
		return err
	}
	if err := s.pushBalance(ctx, hub, d, p.UserID, v.SourceAccountID); err != nil {
		return err
	}
	if p.RecipientID != uuid.Nil && v.DestinationAccountID != nil {
		return s.pushBalance(ctx, hub, d, p.RecipientID, *v.DestinationAccountID)
	}
	return nil
}

func (s *Service) pushBalance(ctx context.Context, hub *realtime.Hub, d jobs.Delivery, user, account uuid.UUID) error {
	b, err := ledger.GetBalances(ctx, s.pool, account)
	if err != nil {
		return fmt.Errorf("balances of %s: %w", account, err)
	}
	return hub.Publish(user, realtime.Event{
		ID: eventID(d, "account.balance_updated:"+user.String()), Type: "account.balance_updated", OccurredAt: d.CreatedAt.UTC(),
		Data: map[string]any{
			"account_id": account, "ledger_balance": accounts.Money(b.Ledger), "available_balance": accounts.Money(b.Available),
		},
	})
}

func (s *Service) pushRequest(ctx context.Context, hub *realtime.Hub, d jobs.Delivery) error {
	var p struct {
		RequestID uuid.UUID `json:"request_id"`
		PayerID   uuid.UUID `json:"payer_id"`
	}
	if err := json.Unmarshal(d.Payload, &p); err != nil {
		return fmt.Errorf("money request event payload: %w", err)
	}
	r, err := s.q.GetMoneyRequest(ctx, transfersdb.GetMoneyRequestParams{ID: p.RequestID, UserID: p.PayerID})
	if err != nil {
		return fmt.Errorf("load money request: %w", err)
	}
	rv, err := s.requestView(ctx, p.PayerID, r)
	if err != nil {
		return err
	}
	data := RequestJSON(rv)
	return hub.Publish(p.PayerID, realtime.Event{ID: eventID(d, "money_request.received"), Type: "money_request.received", OccurredAt: d.CreatedAt.UTC(), Data: data})
}
