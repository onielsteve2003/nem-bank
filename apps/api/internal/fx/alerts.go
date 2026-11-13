package fx

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/fx/fxdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/realtime"
)

const (
	// maxActiveAlerts is the contract's cap on one customer's list.
	maxActiveAlerts = 10
	// alertKeep is how long a fired alert stays in the list, and in the table.
	alertKeep = 7 * 24 * time.Hour
	// topicAlert is the outbox topic of a fired alert.
	topicAlert = "fx.alert_triggered"
	// topicInbound is the outbox topic of a demo inbound credit.
	topicInbound = "demo.inbound_received"
)

var (
	// ErrAlertNotFound is the 404 for an alert the caller does not have.
	ErrAlertNotFound = problem.NotFound("Alert")
	errTooManyAlerts = problem.New(http.StatusUnprocessableEntity, "too_many_alerts", "You can have up to 10 rate alerts").
				WithDetail("Delete one to add another.")
)

// Alert is a rate alert (contract FxAlert).
type Alert struct {
	ID            uuid.UUID
	Pair          string
	Direction     string
	Target        Rate
	Status        string
	CreatedAt     time.Time
	TriggeredAt   *time.Time
	TriggeredRate Rate
}

func alertView(a fxdb.FxAlert) Alert {
	out := Alert{ID: a.ID, Pair: a.Pair, Direction: a.Direction, Target: Rate(a.TargetE8), Status: a.Status, CreatedAt: a.CreatedAt.UTC()}
	if a.TriggeredAt.Valid {
		t := a.TriggeredAt.Time.UTC()
		out.TriggeredAt = &t
	}
	if a.TriggeredRateE8.Valid {
		out.TriggeredRate = Rate(a.TriggeredRateE8.Int64)
	}
	return out
}

// AlertJSON is the contract's FxAlert.
func AlertJSON(a Alert) api.FxAlert {
	return api.FxAlert{
		Id: a.ID, Pair: a.Pair, Direction: api.FxAlertDirection(a.Direction), TargetRate: a.Target.String(),
		Status: api.FxAlertStatus(a.Status), CreatedAt: a.CreatedAt, TriggeredAt: a.TriggeredAt,
	}
}

func knownPair(pair string) bool {
	for _, p := range Pairs {
		if p == pair {
			return true
		}
	}
	return false
}

// CreateAlert watches a pair for the customer (FX-2).
func (s *Service) CreateAlert(ctx context.Context, pair, direction, target string) (Alert, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return Alert{}, problem.Unauthorized()
	}
	if !knownPair(pair) {
		return Alert{}, problem.Validation(problem.Field("/pair", "unsupported", "Pick USD-NGN, GBP-NGN or EUR-NGN."))
	}
	rate, err := ParseRate(target)
	if err != nil {
		return Alert{}, problem.Validation(problem.Field("/target_rate", "invalid_rate", "Enter a rate above zero with up to 8 decimals."))
	}
	n, err := s.q.CountActiveAlerts(ctx, p.UserID)
	if err != nil {
		return Alert{}, fmt.Errorf("count alerts: %w", err)
	}
	if n >= maxActiveAlerts {
		return Alert{}, errTooManyAlerts
	}
	id, err := uuid.NewV7()
	if err != nil {
		return Alert{}, fmt.Errorf("alert id: %w", err)
	}
	row, err := s.q.InsertAlert(ctx, fxdb.InsertAlertParams{
		ID: id, UserID: p.UserID, Pair: pair, Direction: direction, TargetE8: int64(rate), CreatedAt: s.now().UTC(),
	})
	if err != nil {
		return Alert{}, fmt.Errorf("insert alert: %w", err)
	}
	return alertView(row), nil
}

// Alerts lists the caller's waiting alerts and the ones that fired in the last week.
func (s *Service) Alerts(ctx context.Context) ([]Alert, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return nil, problem.Unauthorized()
	}
	rows, err := s.q.ListAlerts(ctx, fxdb.ListAlertsParams{UserID: p.UserID, Since: s.now().Add(-alertKeep)})
	if err != nil {
		return nil, fmt.Errorf("list alerts: %w", err)
	}
	out := make([]Alert, len(rows))
	for i, r := range rows {
		out[i] = alertView(r)
	}
	return out, nil
}

// DeleteAlert removes one of the caller's alerts.
func (s *Service) DeleteAlert(ctx context.Context, id uuid.UUID) error {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return problem.Unauthorized()
	}
	n, err := s.q.DeleteAlert(ctx, fxdb.DeleteAlertParams{ID: id, UserID: p.UserID})
	if err != nil {
		return fmt.Errorf("delete alert: %w", err)
	}
	if n == 0 {
		return ErrAlertNotFound
	}
	return nil
}

// CheckAlerts compares the newest mid rate of each pair with the waiting alerts and fires
// the ones it has reached. The alert row and its outbox event commit together, so a fired
// alert is announced exactly once: the status change is what stops a second firing.
func (s *Service) CheckAlerts(ctx context.Context) error {
	rows, err := s.q.LatestRates(ctx)
	if err != nil {
		return fmt.Errorf("latest rates: %w", err)
	}
	now := s.now().UTC()
	var errs []error
	for _, r := range rows {
		if now.Sub(r.AsOf) > staleAfter {
			continue // an old reading is not news
		}
		errs = append(errs, s.fire(ctx, r.Pair, r.MidE8, now))
	}
	return errors.Join(errs...)
}

func (s *Service) fire(ctx context.Context, pair string, midE8 int64, now time.Time) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		fired, err := fxdb.New(tx).TriggerAlerts(ctx, fxdb.TriggerAlertsParams{
			Now: pgtype.Timestamptz{Time: now, Valid: true}, MidE8: pgtype.Int8{Int64: midE8, Valid: true}, Pair: pair,
		})
		if err != nil {
			return fmt.Errorf("trigger %s alerts: %w", pair, err)
		}
		for _, a := range fired {
			if _, err := jobs.Write(ctx, tx, jobs.Event{
				Topic: topicAlert, AggregateType: "fx_alert", AggregateID: a.ID.String(),
				Payload: map[string]any{"user_id": a.UserID, "alert": AlertJSON(alertView(a)), "rate": Rate(midE8).String()},
			}); err != nil {
				return err
			}
		}
		return nil
	})
}

// RealtimeSubscriber pushes a fired alert to its owner's open app (FX-2).
func (s *Service) RealtimeSubscriber(hub *realtime.Hub) jobs.Subscriber {
	return jobs.Subscriber{
		Name:   "realtime_fx_alerts",
		Topics: []string{topicAlert, topicInbound},
		Handle: func(ctx context.Context, d jobs.Delivery) error {
			if d.Topic == topicInbound {
				return s.pushInbound(ctx, hub, d)
			}
			var p struct {
				UserID uuid.UUID   `json:"user_id"`
				Alert  api.FxAlert `json:"alert"`
				Rate   string      `json:"rate"`
			}
			if err := json.Unmarshal(d.Payload, &p); err != nil {
				return fmt.Errorf("alert event payload: %w", err)
			}
			return hub.Publish(p.UserID, realtime.Event{
				ID: d.ID, Type: topicAlert, OccurredAt: d.CreatedAt.UTC(), Data: map[string]any{"alert": p.Alert, "rate": p.Rate},
			})
		},
	}
}

// pushInbound sends the new balance of an account a demo credit landed in.
func (s *Service) pushInbound(ctx context.Context, hub *realtime.Hub, d jobs.Delivery) error {
	var p struct {
		UserID    uuid.UUID `json:"user_id"`
		AccountID uuid.UUID `json:"account_id"`
	}
	if err := json.Unmarshal(d.Payload, &p); err != nil {
		return fmt.Errorf("inbound event payload: %w", err)
	}
	b, err := ledger.GetBalances(ctx, s.pool, p.AccountID)
	if err != nil {
		return fmt.Errorf("balances of %s: %w", p.AccountID, err)
	}
	return hub.Publish(p.UserID, realtime.Event{
		ID: d.ID, Type: "account.balance_updated", OccurredAt: d.CreatedAt.UTC(),
		Data: map[string]any{
			"account_id": p.AccountID, "ledger_balance": accounts.Money(b.Ledger), "available_balance": accounts.Money(b.Available),
		},
	})
}
