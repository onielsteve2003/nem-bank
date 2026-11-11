package notify

import (
	"context"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
)

// API adapts the service to the contract's strict server; the router embeds it. A nil *API
// answers 501.
type API struct{ svc *Service }

// NewAPI returns the notification operations for the router.
func NewAPI(svc *Service) *API { return &API{svc: svc} }

func prefsJSON(p Prefs) api.NotificationPreferences {
	var out api.NotificationPreferences
	out.Categories.Transactions, out.Categories.Security, out.Categories.Savings, out.Categories.Ajo = p["transactions"], p["security"], p["savings"], p["ajo"]
	out.Categories.Credit, out.Categories.Support, out.Categories.Product, out.Categories.Marketing = p["credit"], p["support"], p["product"], p["marketing"]
	return out
}

func prefsFrom(in api.NotificationPreferences) Prefs {
	c := in.Categories
	return Prefs{
		"transactions": c.Transactions, "security": c.Security, "savings": c.Savings, "ajo": c.Ajo,
		"credit": c.Credit, "support": c.Support, "product": c.Product, "marketing": c.Marketing,
	}
}

// ListNotifications is GET /v1/notifications.
func (a *API) ListNotifications(ctx context.Context, req api.ListNotificationsRequestObject) (api.ListNotificationsResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	unreadOnly := req.Params.UnreadOnly != nil && *req.Params.UnreadOnly
	pg, err := a.svc.List(ctx, unreadOnly, req.Params.Cursor, req.Params.Limit)
	if err != nil {
		return nil, err
	}
	out := api.ListNotifications200JSONResponse{Data: make([]api.Notification, len(pg.Items)), Page: pg.Page, UnreadCount: pg.Unread}
	for i, n := range pg.Items {
		out.Data[i] = NotificationJSON(n)
	}
	return out, nil
}

// MarkNotificationsRead is POST /v1/notifications/read.
func (a *API) MarkNotificationsRead(ctx context.Context, req api.MarkNotificationsReadRequestObject) (api.MarkNotificationsReadResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	var ids []api.Uuid
	if req.Body.Ids != nil {
		ids = *req.Body.Ids
	}
	if err := a.svc.MarkRead(ctx, ids, req.Body.All != nil && *req.Body.All); err != nil {
		return nil, err
	}
	return api.MarkNotificationsRead204Response{}, nil
}

// GetNotificationPreferences is GET /v1/notifications/preferences.
func (a *API) GetNotificationPreferences(ctx context.Context, _ api.GetNotificationPreferencesRequestObject) (api.GetNotificationPreferencesResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	p, err := a.svc.GetPreferences(ctx)
	if err != nil {
		return nil, err
	}
	return api.GetNotificationPreferences200JSONResponse(prefsJSON(p)), nil
}

// SetNotificationPreferences is PUT /v1/notifications/preferences.
func (a *API) SetNotificationPreferences(ctx context.Context, req api.SetNotificationPreferencesRequestObject) (api.SetNotificationPreferencesResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	p, err := a.svc.SetPreferences(ctx, prefsFrom(*req.Body))
	if err != nil {
		return nil, err
	}
	return api.SetNotificationPreferences200JSONResponse(prefsJSON(p)), nil
}

// RegisterPushToken is POST /v1/notifications/push-tokens.
func (a *API) RegisterPushToken(ctx context.Context, req api.RegisterPushTokenRequestObject) (api.RegisterPushTokenResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	if err := a.svc.RegisterPushToken(ctx, req.Body.DeviceId, req.Body.ExpoPushToken); err != nil {
		return nil, err
	}
	return api.RegisterPushToken204Response{}, nil
}

// UnregisterPushToken is DELETE /v1/notifications/push-tokens/{device_id}.
func (a *API) UnregisterPushToken(ctx context.Context, req api.UnregisterPushTokenRequestObject) (api.UnregisterPushTokenResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	if err := a.svc.UnregisterPushToken(ctx, req.DeviceId); err != nil {
		return nil, err
	}
	return api.UnregisterPushToken204Response{}, nil
}
