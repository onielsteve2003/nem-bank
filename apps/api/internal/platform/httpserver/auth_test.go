package httpserver

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

const testToken = "test-token"

type callerKey struct{}

// fakeAuth accepts testToken, revokes "revoked" with the domain's own problem, and fails
// "broken" the way a database outage would.
type fakeAuth struct{}

func (fakeAuth) Authenticate(ctx context.Context, bearer string) (context.Context, error) {
	switch bearer {
	case testToken:
		return context.WithValue(ctx, callerKey{}, "tolu"), nil
	case "revoked":
		return nil, problem.New(http.StatusUnauthorized, "session_revoked", "Your session has ended.")
	case "broken":
		return nil, errors.New("connection refused")
	}
	return nil, problem.Unauthorized()
}

func TestProtectedOperationsNeedAValidBearerToken(t *testing.T) {
	t.Parallel()
	h := newTestRouter(t, nil)

	tests := []struct {
		name, auth string
		status     int
		code       string
	}{
		{"no header", "", 401, "unauthorized"},
		{"wrong scheme", "Basic dG9sdTpwdw==", 401, "unauthorized"},
		{"bad token", "Bearer nope", 401, "unauthorized"},
		{"revoked session", "Bearer revoked", 401, "session_revoked"},
		{"auth store down", "Bearer broken", 500, "internal_error"},
		{"valid token, lowercase scheme", "bearer " + testToken, 501, "not_implemented"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			headers := map[string]string{}
			if tt.auth != "" {
				headers["Authorization"] = tt.auth
			}
			rec := do(t, h, http.MethodGet, "/v1/accounts", headers)
			if p := decodeProblem(t, rec); rec.Code != tt.status || p.Code != tt.code {
				t.Fatalf("got %d %s, want %d %s", rec.Code, p.Code, tt.status, tt.code)
			}
			if tt.status == 401 && !strings.HasPrefix(rec.Header().Get("WWW-Authenticate"), "Bearer") {
				t.Fatalf("401 without a WWW-Authenticate challenge")
			}
		})
	}
}

func TestAuthFailureWinsOverBodyErrors(t *testing.T) {
	t.Parallel()

	// An anonymous caller learns nothing about what a protected body should look like.
	req := httptest.NewRequestWithContext(t.Context(), http.MethodPut, "/v1/security/question",
		strings.NewReader(`{"question":"","answer":1}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	newTestRouter(t, nil).ServeHTTP(rec, req)
	if p := decodeProblem(t, rec); rec.Code != http.StatusUnauthorized || p.Errors != nil {
		t.Fatalf("got %d %+v, want a bare 401", rec.Code, p)
	}
}

func TestPublicOperationsNeedNoToken(t *testing.T) {
	t.Parallel()

	rec := do(t, newTestRouter(t, nil), http.MethodGet, "/v1/health", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}
