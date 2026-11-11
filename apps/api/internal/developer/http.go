package developer

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/developer/developerdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// API adapts the service to the contract's strict server; the router embeds it. A nil *API
// answers 501.
type API struct{ svc *Service }

// NewAPI returns the developer operations for the router.
func NewAPI(svc *Service) *API { return &API{svc: svc} }

func keyJSON(k developerdb.ApiKey) api.ApiKey {
	scopes := make([]api.ApiKeyScope, len(k.Scopes))
	for i, s := range k.Scopes {
		scopes[i] = api.ApiKeyScope(s)
	}
	return api.ApiKey{
		Id: k.ID, Name: k.Name, Prefix: k.Prefix, Scopes: scopes, Environment: "sandbox", CreatedAt: k.CreatedAt.UTC(),
		LastUsedAt: k.LastUsedAt, RevokedAt: k.RevokedAt,
	}
}

// ListApiKeys is GET /v1/developer/api-keys.
func (a *API) ListApiKeys(ctx context.Context, _ api.ListApiKeysRequestObject) (api.ListApiKeysResponseObject, error) { //nolint:revive // the name is fixed by the generated server interface
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	rows, err := a.svc.Keys(ctx)
	if err != nil {
		return nil, err
	}
	out := api.ListApiKeys200JSONResponse{Data: make([]api.ApiKey, len(rows))}
	for i, r := range rows {
		out.Data[i] = keyJSON(r)
	}
	return out, nil
}

// CreateApiKey is POST /v1/developer/api-keys.
func (a *API) CreateApiKey(ctx context.Context, req api.CreateApiKeyRequestObject) (api.CreateApiKeyResponseObject, error) { //nolint:revive // the name is fixed by the generated server interface
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	scopes := make([]string, len(req.Body.Scopes))
	for i, s := range req.Body.Scopes {
		scopes[i] = string(s)
	}
	k, secret, err := a.svc.CreateKey(ctx, req.Body.Name, scopes, req.Params.XStepUpToken)
	if err != nil {
		return nil, err
	}
	noStore := "no-store"
	return api.CreateApiKey201JSONResponse{
		Body:    api.ApiKeyCreated{Key: keyJSON(k), Secret: secret},
		Headers: api.CreateApiKey201ResponseHeaders{CacheControl: &noStore},
	}, nil
}

// RevokeApiKey is DELETE /v1/developer/api-keys/{key_id}.
func (a *API) RevokeApiKey(ctx context.Context, req api.RevokeApiKeyRequestObject) (api.RevokeApiKeyResponseObject, error) { //nolint:revive // the name is fixed by the generated server interface
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	if err := a.svc.RevokeKey(ctx, req.KeyId); err != nil {
		return nil, err
	}
	return api.RevokeApiKey204Response{}, nil
}

// ListWebhookEndpoints is GET /v1/developer/webhooks.
func (a *API) ListWebhookEndpoints(ctx context.Context, _ api.ListWebhookEndpointsRequestObject) (api.ListWebhookEndpointsResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	rows, err := a.svc.Endpoints(ctx)
	if err != nil {
		return nil, err
	}
	out := api.ListWebhookEndpoints200JSONResponse{Data: make([]api.WebhookEndpoint, len(rows))}
	for i, r := range rows {
		out.Data[i] = endpointJSON(r)
	}
	return out, nil
}

// CreateWebhookEndpoint is POST /v1/developer/webhooks.
func (a *API) CreateWebhookEndpoint(ctx context.Context, req api.CreateWebhookEndpointRequestObject) (api.CreateWebhookEndpointResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	e, secret, err := a.svc.CreateEndpoint(ctx, *req.Body)
	if err != nil {
		return nil, err
	}
	return api.CreateWebhookEndpoint201JSONResponse{Endpoint: endpointJSON(e), SigningSecret: secret}, nil
}

// GetWebhookEndpoint is GET /v1/developer/webhooks/{endpoint_id}.
func (a *API) GetWebhookEndpoint(ctx context.Context, req api.GetWebhookEndpointRequestObject) (api.GetWebhookEndpointResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	e, err := a.svc.Endpoint(ctx, req.EndpointId)
	if err != nil {
		return nil, err
	}
	return api.GetWebhookEndpoint200JSONResponse(endpointJSON(e)), nil
}

// UpdateWebhookEndpoint is PATCH /v1/developer/webhooks/{endpoint_id}.
func (a *API) UpdateWebhookEndpoint(ctx context.Context, req api.UpdateWebhookEndpointRequestObject) (api.UpdateWebhookEndpointResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	e, err := a.svc.UpdateEndpoint(ctx, req.EndpointId, *req.Body)
	if err != nil {
		return nil, err
	}
	return api.UpdateWebhookEndpoint200JSONResponse(endpointJSON(e)), nil
}

// DeleteWebhookEndpoint is DELETE /v1/developer/webhooks/{endpoint_id}.
func (a *API) DeleteWebhookEndpoint(ctx context.Context, req api.DeleteWebhookEndpointRequestObject) (api.DeleteWebhookEndpointResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	if err := a.svc.DeleteEndpoint(ctx, req.EndpointId); err != nil {
		return nil, err
	}
	return api.DeleteWebhookEndpoint204Response{}, nil
}

// RotateWebhookSecret is POST /v1/developer/webhooks/{endpoint_id}/rotate-secret.
func (a *API) RotateWebhookSecret(ctx context.Context, req api.RotateWebhookSecretRequestObject) (api.RotateWebhookSecretResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	e, secret, err := a.svc.RotateSecret(ctx, req.EndpointId)
	if err != nil {
		return nil, err
	}
	return api.RotateWebhookSecret200JSONResponse{Endpoint: endpointJSON(e), SigningSecret: secret}, nil
}

// SendTestWebhook is POST /v1/developer/webhooks/{endpoint_id}/test.
func (a *API) SendTestWebhook(ctx context.Context, req api.SendTestWebhookRequestObject) (api.SendTestWebhookResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	d, err := a.svc.SendTest(ctx, req.EndpointId)
	if err != nil {
		return nil, err
	}
	return api.SendTestWebhook202JSONResponse(d), nil
}

// ListWebhookDeliveries is GET /v1/developer/webhooks/{endpoint_id}/deliveries.
func (a *API) ListWebhookDeliveries(ctx context.Context, req api.ListWebhookDeliveriesRequestObject) (api.ListWebhookDeliveriesResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	var st *string
	if req.Params.Status != nil {
		s := string(*req.Params.Status)
		st = &s
	}
	rows, page, err := a.svc.Deliveries(ctx, req.EndpointId, st, req.Params.Cursor, req.Params.Limit)
	if err != nil {
		return nil, err
	}
	return api.ListWebhookDeliveries200JSONResponse{Data: rows, Page: page}, nil
}

// ReplayWebhookDelivery is POST /v1/developer/webhook-deliveries/{delivery_id}/replay.
func (a *API) ReplayWebhookDelivery(ctx context.Context, req api.ReplayWebhookDeliveryRequestObject) (api.ReplayWebhookDeliveryResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	d, err := a.svc.Replay(ctx, req.DeliveryId)
	if err != nil {
		return nil, err
	}
	return api.ReplayWebhookDelivery202JSONResponse(d), nil
}

// SimulateSandboxPayment is POST /v1/developer/sandbox/payments: a sandbox payer pays one of the
// caller's payment links, so webhooks can be tested without a second customer.
func (a *API) SimulateSandboxPayment(ctx context.Context, req api.SimulateSandboxPaymentRequestObject) (api.SimulateSandboxPaymentResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	uid, err := owner(ctx)
	if err != nil {
		return nil, err
	}
	payer := ""
	if req.Body.PayerName != nil {
		payer = *req.Body.PayerName
	}
	if req.Body.Amount != nil {
		if m, err := money.ParseMinor(req.Body.Amount.AmountMinor, string(req.Body.Amount.Currency)); err != nil || m.Currency() != money.NGN {
			return nil, problem.Validation(problem.Field("/amount", "invalid", "Give a naira amount."))
		}
	}
	t, err := a.svc.transfers.SandboxLinkPayment(ctx, uid, req.Body.PaymentLinkId, req.Body.Amount, payer)
	if err != nil {
		return nil, err
	}
	return api.SimulateSandboxPayment201JSONResponse(t), nil
}

// ---------------------------------------------------------------- public docs (DEV-4)

const docsPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nem Bank API</title>
</head>
<body>
  <script id="api-reference" data-url="/openapi.json"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.24.0"></script>
</body>
</html>
`

// DocsPath and SpecPath are the public API reference and the contract it renders.
const (
	DocsPath = "/docs"
	SpecPath = "/openapi.json"
)

// DocsHandler serves the Scalar API reference. The page loads one pinned script from a CDN and
// the contract from this server, and nothing else is allowed by its content security policy.
func DocsHandler(c *gin.Context) {
	h := c.Writer.Header()
	h.Set("Content-Security-Policy", "default-src 'none'; script-src https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; "+
		"font-src https://cdn.jsdelivr.net https://fonts.gstatic.com data:; img-src data: https:; connect-src 'self'; frame-ancestors 'none'")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "public, max-age=300")
	c.Data(http.StatusOK, "text/html; charset=utf-8", []byte(docsPage))
}

// SpecHandler serves the OpenAPI contract the server was built from.
func SpecHandler(c *gin.Context) {
	spec, err := api.GetSpec()
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	b, err := json.Marshal(spec)
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	c.Header("Cache-Control", "public, max-age=300")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Data(http.StatusOK, "application/json", b)
}

var _ = identity.ErrStepUpRequired
