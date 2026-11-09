package mailer

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBrevoPostsTheMessageWithTheAPIKey(t *testing.T) {
	t.Parallel()

	var got brevoRequest
	var key string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key = r.Header.Get("api-key")
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode: %v", err)
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	b := Brevo{APIKey: "k1", FromEmail: "no-reply@nem.test", FromName: "Nem Bank", Endpoint: srv.URL}
	err := b.Send(t.Context(), Message{To: "tolu@example.com", Subject: "Your code", Text: "123456"})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if key != "k1" || got.Sender.Email != "no-reply@nem.test" || len(got.To) != 1 ||
		got.To[0].Email != "tolu@example.com" || got.TextContent != "123456" {
		t.Fatalf("unexpected request: key %q, body %+v", key, got)
	}
}

func TestBrevoReportsARejectedSend(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"message":"Key not found"}`))
	}))
	defer srv.Close()

	err := Brevo{APIKey: "bad", FromEmail: "a@b.c", Endpoint: srv.URL}.Send(t.Context(), Message{To: "x@y.z"})
	if err == nil || !strings.Contains(err.Error(), "status 401") {
		t.Fatalf("err = %v, want a status 401 error", err)
	}
}
