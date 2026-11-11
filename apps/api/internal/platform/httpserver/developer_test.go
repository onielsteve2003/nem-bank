package httpserver

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/developer"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// fakeKeys stands in for the developer service: "nem_test_wide…" carries every read scope,
// "nem_test_narrow…" only webhooks_manage; anything else is not a key.
type fakeKeys struct{}

func (fakeKeys) Authenticate(ctx context.Context, bearer string) (context.Context, error) {
	var scopes []string
	switch {
	case strings.HasPrefix(bearer, "nem_test_wide"):
		scopes = []string{"accounts_read", "transactions_read", "webhooks_manage"}
	case strings.HasPrefix(bearer, "nem_test_narrow"):
		scopes = []string{"webhooks_manage"}
	default:
		return nil, problem.Unauthorized()
	}
	ctx = developer.WithKey(ctx, developer.Key{ID: uuid.New(), Scopes: scopes})
	return identity.WithPrincipal(ctx, identity.Principal{UserID: uuid.New()}), nil
}

func routerWithKeys(t *testing.T) http.Handler {
	t.Helper()
	r, err := NewRouter(Options{
		Version: "test-1", Logger: slog.New(slog.NewJSONHandler(io.Discard, nil)),
		Authenticator: fakeAuth{}, KeyAuthenticator: fakeKeys{},
	})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func bearer(token string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + token}
}

func TestAnAPIKeyReachesOnlyWhatItsScopesAllow(t *testing.T) {
	t.Parallel()
	h := routerWithKeys(t)
	// listAccounts takes accounts_read: the wide key passes the gate (and meets the handler, which this router
	// leaves unwired), the narrow one is refused, and junk is a 401.
	if rec := do(t, h, http.MethodGet, "/v1/accounts", bearer("nem_test_wide00000000000000000000000000")); rec.Code == http.StatusUnauthorized || rec.Code == http.StatusForbidden {
		t.Fatalf("a key with the scope was stopped at the gate: %d %s", rec.Code, rec.Body)
	}
	if rec := do(t, h, http.MethodGet, "/v1/accounts", bearer("nem_test_narrow000000000000000000000000")); rec.Code != http.StatusForbidden {
		t.Fatalf("a key without the scope got %d: %s", rec.Code, rec.Body)
	}
	if rec := do(t, h, http.MethodGet, "/v1/accounts", bearer("nem_test_nonsense")); rec.Code != http.StatusUnauthorized {
		t.Fatalf("a bad key got %d", rec.Code)
	}
	// An operation that does not list apiKeyAuth never accepts a key, whatever its scopes.
	if rec := do(t, h, http.MethodGet, "/v1/beneficiaries", bearer("nem_test_wide00000000000000000000000000")); rec.Code != http.StatusUnauthorized {
		t.Fatalf("a key on a session-only operation got %d", rec.Code)
	}
	// The developer endpoints need the scope that matches what they do.
	if rec := do(t, h, http.MethodGet, "/v1/developer/webhooks", bearer("nem_test_narrow000000000000000000000000")); rec.Code != http.StatusNotImplemented {
		t.Fatalf("webhooks_manage on webhooks got %d: %s", rec.Code, rec.Body)
	}
	if rec := do(t, h, http.MethodGet, "/v1/developer/webhooks/"+uuid.NewString()+"/deliveries", bearer("nem_test_wide00000000000000000000000000")); rec.Code != http.StatusNotImplemented {
		t.Fatalf("wide key (has webhooks_manage) on deliveries got %d", rec.Code)
	}
	// A signed-in customer has no scopes to check and is not held to any.
	if rec := do(t, h, http.MethodGet, "/v1/developer/webhooks", map[string]string{"Authorization": "Bearer " + testToken}); rec.Code != http.StatusNotImplemented {
		t.Fatalf("a session on webhooks got %d", rec.Code)
	}
}

func TestThePublicDocsAndContractAreServed(t *testing.T) {
	t.Parallel()
	h := newTestRouter(t, nil)
	docs := do(t, h, http.MethodGet, "/docs", nil)
	if docs.Code != http.StatusOK || !strings.Contains(docs.Body.String(), "api-reference") || !strings.Contains(docs.Header().Get("Content-Security-Policy"), "default-src 'none'") {
		t.Fatalf("docs = %d, CSP %q", docs.Code, docs.Header().Get("Content-Security-Policy"))
	}
	if strings.Contains(docs.Body.String(), "@scalar/api-reference\"") || !strings.Contains(docs.Body.String(), "@scalar/api-reference@") {
		t.Fatal("the docs script is not pinned to a version")
	}
	spec := do(t, h, http.MethodGet, "/openapi.json", nil)
	if spec.Code != http.StatusOK || !strings.Contains(spec.Body.String(), `"/v1/developer/api-keys"`) || spec.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("spec = %d %s", spec.Code, spec.Header().Get("Content-Type"))
	}
}
