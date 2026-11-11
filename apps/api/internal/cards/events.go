package cards

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/cards/cardsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/realtime"
)

// Card events. Every outcome of an authorization is written to the outbox in the same
// transaction as the outcome itself, so an event exists exactly when the money moved (or
// the decline was recorded) and never otherwise. Other domains subscribe by topic:
//
//	card.authorized  an approved charge, money held      → notifications, spend insights
//	card.declined    a refused charge, with its reason   → notifications, fraud signals
//	card.settled     the merchant captured, money moved  → round-ups (savings), insights
//	card.reversed    the hold was released or lapsed     → notifications
//
// Round-ups and insights act on card.settled: a round-up is taken from what was really
// charged, not from a hold that may never settle.
const (
	TopicAuthorized = "card.authorized"
	TopicDeclined   = "card.declined"
	TopicSettled    = "card.settled"
	TopicReversed   = "card.reversed"
)

// Event is the payload of every card.* outbox event. It carries what a subscriber needs to
// word a notification or file a charge without calling back into the card domain.
type Event struct {
	UserID          uuid.UUID  `json:"user_id"`
	CardID          uuid.UUID  `json:"card_id"`
	CardLast4       string     `json:"card_last4"`
	CardNickname    *string    `json:"card_nickname,omitempty"`
	AccountID       uuid.UUID  `json:"account_id"`
	AuthorizationID uuid.UUID  `json:"authorization_id"`
	TransactionID   *uuid.UUID `json:"transaction_id,omitempty"`
	Status          string     `json:"status"`
	DeclineReason   *string    `json:"decline_reason,omitempty"`
	MerchantID      string     `json:"merchant_id"`
	MerchantName    string     `json:"merchant_name"`
	MCC             string     `json:"mcc"`
	Country         string     `json:"country"`
	Channel         string     `json:"channel"`
	// Category is the spending category the charge is filed under (same as its history line).
	Category string `json:"category"`
	// Amount is in the merchant's currency, Billing in the card's.
	AmountMinor     int64  `json:"amount_minor"`
	AmountCurrency  string `json:"amount_currency"`
	BillingMinor    int64  `json:"billing_minor"`
	BillingCurrency string `json:"billing_currency"`
}

// topicFor is the event an authorization's current status is announced under.
func topicFor(status string) string {
	switch status {
	case AuthDeclined:
		return TopicDeclined
	case AuthSettled:
		return TopicSettled
	case AuthReversed:
		return TopicReversed
	default:
		return TopicAuthorized
	}
}

// emit writes the event for an authorization's new state, in the caller's transaction.
func emit(ctx context.Context, tx pgx.Tx, card cardsdb.Card, a cardsdb.CardAuthorization) error {
	_, err := jobs.Write(ctx, tx, jobs.Event{
		Topic: topicFor(a.Status), AggregateType: "card_authorization", AggregateID: a.ID.String(),
		Payload: Event{
			UserID: a.UserID, CardID: card.ID, CardLast4: card.Last4, CardNickname: card.Nickname, AccountID: a.AccountID,
			AuthorizationID: a.ID, TransactionID: a.TransactionID, Status: a.Status, DeclineReason: a.DeclineReason,
			MerchantID: a.MerchantID, MerchantName: a.MerchantName, MCC: a.Mcc, Country: a.Country, Channel: a.Channel,
			Category: categoryFor(a.Mcc), AmountMinor: a.AmountMinor, AmountCurrency: a.AmountCurrency,
			BillingMinor: a.BillingMinor, BillingCurrency: a.BillingCurrency,
		},
	})
	if err != nil {
		return fmt.Errorf("write %s event: %w", topicFor(a.Status), err)
	}
	return nil
}

// RealtimeSubscriber pushes each outcome to the cardholder's open app (CARD-5): the charge
// as a card.authorization event, and for anything that changes what they can spend, the
// account's new balances. A decline changes no balance, so it sends only the charge.
func (s *Service) RealtimeSubscriber(hub *realtime.Hub) jobs.Subscriber {
	return jobs.Subscriber{
		Name:   "realtime_cards",
		Topics: []string{TopicAuthorized, TopicDeclined, TopicSettled, TopicReversed},
		Handle: func(ctx context.Context, d jobs.Delivery) error {
			var e Event
			if err := json.Unmarshal(d.Payload, &e); err != nil {
				return fmt.Errorf("card event payload: %w", err)
			}
			// Read the authorization as it is now: a stale event still tells the app the truth.
			a, err := s.q.GetAuthorization(ctx, e.AuthorizationID)
			if err != nil {
				return fmt.Errorf("load authorization: %w", err)
			}
			if err := hub.Publish(e.UserID, realtime.Event{
				ID: uuid.NewSHA1(d.ID, []byte("card.authorization")), Type: "card.authorization", OccurredAt: d.CreatedAt.UTC(), Data: TransactionJSON(a),
			}); err != nil {
				return err
			}
			if d.Topic == TopicDeclined {
				return nil
			}
			b, err := ledger.GetBalances(ctx, s.pool, e.AccountID)
			if err != nil {
				return fmt.Errorf("balances of %s: %w", e.AccountID, err)
			}
			return hub.Publish(e.UserID, realtime.Event{
				ID: uuid.NewSHA1(d.ID, []byte("account.balance_updated")), Type: "account.balance_updated", OccurredAt: d.CreatedAt.UTC(),
				Data: map[string]any{
					"account_id": e.AccountID, "ledger_balance": accounts.Money(b.Ledger), "available_balance": accounts.Money(b.Available),
				},
			})
		},
	}
}
