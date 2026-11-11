// Package notify is the customer's notification inbox (NOT-1), their per-category channel
// preferences (NOT-2) and the copies sent by Expo push and email (NOT-3).
//
// Domains never call this package. They write outbox events in the same transaction as
// their state change; the Subscriber here turns those into inbox rows. The row is written
// first and is the source of truth, then the realtime socket, push and email follow only
// where the customer's preferences allow.
package notify

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/notify/notifydb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/mailer"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/pagination"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/realtime"
)

// Categories are the contract's NotificationCategory values, in display order.
var Categories = []string{"transactions", "security", "savings", "ajo", "credit", "support", "product", "marketing"}

// Channels is what one category sends where.
type Channels = api.ChannelPreferences

// Prefs is a customer's channel choices by category name.
type Prefs map[string]Channels

// Defaults are what a customer has before they change anything. Marketing is off in every
// channel (NOT-2). Email is on only for what a customer would want in writing: money moving,
// security and credit.
func Defaults() Prefs {
	on := Channels{InApp: true, Push: true, Email: false}
	p := Prefs{}
	for _, c := range Categories {
		p[c] = on
	}
	for _, c := range []string{"transactions", "security", "credit"} {
		p[c] = Channels{InApp: true, Push: true, Email: true}
	}
	p["product"] = Channels{InApp: true}
	p["marketing"] = Channels{}
	return p
}

var errSecurityOff = problem.Validation(problem.Field("/categories/security", "required",
	"Security alerts cannot be switched off entirely. Keep at least one channel on."))

// Config holds the service's dependencies.
type Config struct {
	Pool   *pgxpool.Pool
	Mailer mailer.Mailer
	// Hub pushes new notifications to open apps; nil skips realtime.
	Hub *realtime.Hub
	// Pusher sends Expo push; nil skips push.
	Pusher Pusher
	Logger *slog.Logger
	// Now defaults to time.Now.
	Now func() time.Time
}

// Service is the notifications domain.
type Service struct {
	pool   *pgxpool.Pool
	q      *notifydb.Queries
	mail   mailer.Mailer
	hub    *realtime.Hub
	pusher Pusher
	log    *slog.Logger
	now    func() time.Time
}

// NewService builds the service.
func NewService(cfg Config) (*Service, error) {
	if cfg.Pool == nil || cfg.Logger == nil {
		return nil, errors.New("notify: pool and logger are required")
	}
	s := &Service{pool: cfg.Pool, q: notifydb.New(cfg.Pool), mail: cfg.Mailer, hub: cfg.Hub, pusher: cfg.Pusher, log: cfg.Logger.With("component", "notify"), now: cfg.Now}
	if s.now == nil {
		s.now = time.Now
	}
	return s, nil
}

func principal(ctx context.Context) (identity.Principal, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return identity.Principal{}, problem.Unauthorized()
	}
	return p, nil
}

// Preferences returns the customer's choices: what they saved over the defaults.
func (s *Service) preferences(ctx context.Context, userID uuid.UUID) (Prefs, error) {
	out := Defaults()
	raw, err := s.q.GetPreferences(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, nil
	}
	if err != nil {
		return nil, fmt.Errorf("load preferences: %w", err)
	}
	var saved Prefs
	if err := json.Unmarshal(raw, &saved); err != nil {
		return nil, fmt.Errorf("decode preferences: %w", err)
	}
	for k, v := range saved {
		if _, known := out[k]; known {
			out[k] = v
		}
	}
	return out, nil
}

// GetPreferences is the signed-in customer's preferences.
func (s *Service) GetPreferences(ctx context.Context) (Prefs, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	return s.preferences(ctx, p.UserID)
}

// SetPreferences saves new choices. Every category must be present, and security keeps at
// least one channel on so a customer cannot silence their own fraud alerts.
func (s *Service) SetPreferences(ctx context.Context, in Prefs) (Prefs, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	for _, c := range Categories {
		if _, ok := in[c]; !ok {
			return nil, problem.Validation(problem.Field("/categories/"+c, "required", "Every category needs a setting."))
		}
	}
	if sec := in["security"]; !sec.InApp && !sec.Push && !sec.Email {
		return nil, errSecurityOff
	}
	raw, err := json.Marshal(in)
	if err != nil {
		return nil, fmt.Errorf("encode preferences: %w", err)
	}
	if err := s.q.SetPreferences(ctx, notifydb.SetPreferencesParams{UserID: p.UserID, Categories: raw, Now: s.now().UTC()}); err != nil {
		return nil, fmt.Errorf("save preferences: %w", err)
	}
	return in, nil
}

// Page is one page of the inbox.
type Page struct {
	Items  []notifydb.Notification
	Page   api.PageInfo
	Unread int
}

// List is the inbox, newest first.
func (s *Service) List(ctx context.Context, unreadOnly bool, cursor *string, limit *int) (Page, error) {
	p, err := principal(ctx)
	if err != nil {
		return Page{}, err
	}
	after, err := pagination.Decode(cursor)
	if err != nil {
		return Page{}, err
	}
	// The first page starts after every row: year 9999 and the largest UUID.
	afterTime, afterID := time.Date(9999, 12, 31, 0, 0, 0, 0, time.UTC), uuid.UUID{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}
	if !after.IsZero() {
		afterTime, afterID = after.Time, after.ID
	}
	n := pagination.Limit(limit)
	rows, err := s.q.ListNotifications(ctx, notifydb.ListNotificationsParams{
		UserID: p.UserID, UnreadOnly: unreadOnly, AfterTime: afterTime, AfterID: afterID, PageSize: int32(n + 1), //nolint:gosec // n is at most 100
	})
	if err != nil {
		return Page{}, fmt.Errorf("list notifications: %w", err)
	}
	unread, err := s.q.CountUnread(ctx, p.UserID)
	if err != nil {
		return Page{}, fmt.Errorf("count unread: %w", err)
	}
	items, info := pagination.Page(rows, n, func(r notifydb.Notification) pagination.Cursor {
		return pagination.Cursor{Time: r.CreatedAt, ID: r.ID}
	})
	return Page{Items: items, Page: info, Unread: int(unread)}, nil
}

// MarkRead marks the given notifications, or all of them, as read. Ids that are not the
// caller's match nothing.
func (s *Service) MarkRead(ctx context.Context, ids []uuid.UUID, all bool) error {
	p, err := principal(ctx)
	if err != nil {
		return err
	}
	now := s.now().UTC()
	if all {
		return s.q.MarkAllRead(ctx, notifydb.MarkAllReadParams{UserID: p.UserID, Now: &now})
	}
	if len(ids) == 0 {
		return problem.Validation(problem.Field("/", "required", "Send ids, or all: true."))
	}
	return s.q.MarkRead(ctx, notifydb.MarkReadParams{UserID: p.UserID, Ids: ids, Now: &now})
}

var errDevice = problem.New(http.StatusNotFound, problem.CodeNotFound, "Device not found.")

// RegisterPushToken stores the Expo token for one of the caller's devices.
func (s *Service) RegisterPushToken(ctx context.Context, deviceID uuid.UUID, token string) error {
	p, err := principal(ctx)
	if err != nil {
		return err
	}
	rows, err := s.q.UpsertPushToken(ctx, notifydb.UpsertPushTokenParams{DeviceID: deviceID, UserID: p.UserID, Token: token, Now: s.now().UTC()})
	if err != nil {
		return fmt.Errorf("save push token: %w", err)
	}
	if rows == 0 {
		return errDevice
	}
	return nil
}

// UnregisterPushToken stops push to a device. Removing a token that is not there is fine.
func (s *Service) UnregisterPushToken(ctx context.Context, deviceID uuid.UUID) error {
	p, err := principal(ctx)
	if err != nil {
		return err
	}
	return s.q.DeletePushToken(ctx, notifydb.DeletePushTokenParams{DeviceID: deviceID, UserID: p.UserID})
}

// NotificationJSON is the contract's Notification.
func NotificationJSON(n notifydb.Notification) api.Notification {
	return api.Notification{
		Id: n.ID, Category: api.NotificationCategory(n.Category), Title: n.Title, Body: n.Body,
		Read: n.ReadAt != nil, DeepLink: n.DeepLink, CreatedAt: n.CreatedAt.UTC(),
	}
}

// Subscriber turns domain events into notifications. Delivery is at-least-once: the inbox
// row is keyed by event and role, so a redelivery finds the row and sends nothing again.
// Push and email are best effort: a failure is logged and never retried, because retrying
// the delivery would only find the row and skip them anyway.
func (s *Service) Subscriber() jobs.Subscriber {
	return jobs.Subscriber{
		Name:   "notifications",
		Topics: Topics,
		Handle: func(ctx context.Context, d jobs.Delivery) error {
			drafts, err := compose(d)
			if err != nil {
				return err
			}
			for _, dr := range drafts {
				if err := s.deliver(ctx, d, dr); err != nil {
					return err
				}
			}
			return nil
		},
	}
}

func (s *Service) deliver(ctx context.Context, d jobs.Delivery, dr draft) error {
	prefs, err := s.preferences(ctx, dr.UserID)
	if err != nil {
		return err
	}
	ch := prefs[dr.Category]
	if !ch.InApp && !ch.Push && !ch.Email {
		return nil
	}
	id, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("notification id: %w", err)
	}
	var link *string
	if dr.DeepLink != "" {
		link = &dr.DeepLink
	}
	// The inbox row is kept whenever any channel is on, so push and email always have an
	// in-app copy to open. The in_app switch only decides whether the socket is nudged.
	n, err := s.q.InsertNotification(ctx, notifydb.InsertNotificationParams{
		ID: id, UserID: dr.UserID, Category: dr.Category, Title: dr.Title, Body: dr.Body, DeepLink: link,
		DedupeKey: d.ID.String() + ":" + dr.Role, CreatedAt: s.now().UTC(),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil // already delivered
	}
	if err != nil {
		return fmt.Errorf("insert notification: %w", err)
	}
	if ch.InApp && s.hub != nil {
		if err := s.hub.Publish(dr.UserID, realtime.Event{
			ID: uuid.NewSHA1(d.ID, []byte("notification.created:"+dr.Role)), Type: "notification.created", OccurredAt: n.CreatedAt, Data: NotificationJSON(n),
		}); err != nil {
			s.log.WarnContext(ctx, "realtime notification failed", "error", err.Error())
		}
	}
	if ch.Push && s.pusher != nil {
		s.push(ctx, dr)
	}
	if ch.Email && s.mail != nil {
		s.email(ctx, dr)
	}
	return nil
}

func (s *Service) push(ctx context.Context, dr draft) {
	tokens, err := s.q.ListPushTokens(ctx, dr.UserID)
	if err != nil || len(tokens) == 0 {
		if err != nil {
			s.log.WarnContext(ctx, "list push tokens failed", "error", err.Error())
		}
		return
	}
	dead, err := s.pusher.Push(ctx, tokens, dr.Title, dr.Body, dr.DeepLink)
	if err != nil {
		s.log.WarnContext(ctx, "push failed", "error", err.Error())
		return
	}
	for _, t := range dead {
		if err := s.q.DeletePushTokenByValue(ctx, t); err != nil {
			s.log.WarnContext(ctx, "delete dead push token failed", "error", err.Error())
		}
	}
}

func (s *Service) email(ctx context.Context, dr draft) {
	to, err := s.q.GetEmail(ctx, dr.UserID)
	if err != nil {
		s.log.WarnContext(ctx, "email address lookup failed", "error", err.Error())
		return
	}
	if err := s.mail.Send(ctx, mailer.Message{To: to, Subject: dr.Title + " - Nem Bank", Text: dr.Body + "\n\nThis is a demo bank. No real money moves."}); err != nil {
		s.log.WarnContext(ctx, "notification email failed", "error", err.Error())
	}
}
