package httpserver

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func send(t *testing.T, h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequestWithContext(t.Context(), method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

const validSignup = `{"first_name":"Ada","last_name":"Obi","email":"ada@example.com","phone":"+2348031234567",` +
	`"date_of_birth":"1990-04-01","consent":{"terms_version":"2026-10","privacy_version":"2026-10","accepted_at":"2026-11-09T10:00:00Z"}}`

func TestValidationRejectsAMissingRequiredFieldWithAPointer(t *testing.T) {
	t.Parallel()

	rec := send(t, newTestRouter(t, nil), http.MethodPost, "/v1/auth/signup", `{"first_name":"Ada"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body)
	}
	p := decodeProblem(t, rec)
	if p.Code != "validation_failed" || p.Errors == nil {
		t.Fatalf("unexpected problem: %+v", p)
	}
	fields := map[string]string{}
	for _, e := range *p.Errors {
		fields[e.Field] = e.Code
	}
	if fields["/last_name"] != "required" || fields["/email"] != "required" {
		t.Fatalf("want required errors on /last_name and /email, got %+v", *p.Errors)
	}
}

func TestValidationNeverEchoesTheSubmittedValue(t *testing.T) {
	t.Parallel()

	h := newTestRouter(t, nil)
	cases := []struct{ name, method, path, body, secret string }{
		{"bad email", http.MethodPost, "/v1/auth/signup",
			strings.Replace(validSignup, `"ada@example.com"`, `"secret-not-an-email"`, 1), "secret-not-an-email"},
		{"out of range number", http.MethodGet, "/v1/beneficiaries?limit=98765", "", "98765"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := send(t, h, tc.method, tc.path, tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body)
			}
			if strings.Contains(rec.Body.String(), tc.secret) {
				t.Fatalf("submitted value leaked into the problem: %s", rec.Body)
			}
		})
	}
}

func TestValidationRejectsMalformedJSON(t *testing.T) {
	t.Parallel()

	rec := send(t, newTestRouter(t, nil), http.MethodPost, "/v1/auth/signup", `{"first_name":`)
	if rec.Code != http.StatusBadRequest || decodeProblem(t, rec).Code != "validation_failed" {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
}

func TestValidationNamesAnOutOfRangeQueryParameter(t *testing.T) {
	t.Parallel()

	rec := send(t, newTestRouter(t, nil), http.MethodGet, "/v1/beneficiaries?limit=500", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body)
	}
	p := decodeProblem(t, rec)
	if p.Errors == nil || len(*p.Errors) != 1 || (*p.Errors)[0].Field != "query.limit" || (*p.Errors)[0].Code != "too_large" ||
		(*p.Errors)[0].Message != "Must be at most 100." {
		t.Fatalf("unexpected errors: %+v", p.Errors)
	}
}

func TestValidRequestsReachTheUnimplementedHandlerAs501(t *testing.T) {
	t.Parallel()

	h := newTestRouter(t, nil)
	cases := []struct{ name, method, path, body string }{
		{"json body", http.MethodPut, "/v1/security/question", `{"question":"First school?","answer":"Corona"}`},
		// OpenAPI 3.1 `type: [string, 'null']` must accept null.
		{"3.1 nullable field", http.MethodPatch, "/v1/beneficiaries/0190f5a2-7b1c-7c3d-8e4f-123456789abc", `{"nickname":null}`},
		{"query parameters", http.MethodGet, "/v1/beneficiaries?limit=5&favourite=true", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := send(t, h, tc.method, tc.path, tc.body)
			if rec.Code != http.StatusNotImplemented {
				t.Fatalf("status = %d, want 501: %s", rec.Code, rec.Body)
			}
			if p := decodeProblem(t, rec); p.Code != "not_implemented" {
				t.Fatalf("unexpected problem: %+v", p)
			}
		})
	}
}

func TestValidationRejectsAWrongTypeOnANullableField(t *testing.T) {
	t.Parallel()

	rec := send(t, newTestRouter(t, nil), http.MethodPatch,
		"/v1/beneficiaries/0190f5a2-7b1c-7c3d-8e4f-123456789abc", `{"nickname":42}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body)
	}
	p := decodeProblem(t, rec)
	if p.Errors == nil || (*p.Errors)[0].Field != "/nickname" || (*p.Errors)[0].Code != "wrong_type" {
		t.Fatalf("unexpected errors: %+v", p.Errors)
	}
}
