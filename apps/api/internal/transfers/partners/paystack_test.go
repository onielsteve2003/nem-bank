package partners

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

// fakePaystack answers like Paystack's test mode for the calls the adapter makes.
func fakePaystack(t *testing.T) *httptest.Server {
	t.Helper()
	transfers := map[string]string{} // reference -> status
	mux := http.NewServeMux()
	reply := func(w http.ResponseWriter, code int, ok bool, msg string, data any) {
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(map[string]any{"status": ok, "message": msg, "data": data})
	}
	auth := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer sk_test_abc" {
				reply(w, http.StatusUnauthorized, false, "Invalid key", nil)
				return
			}
			h(w, r)
		}
	}
	mux.HandleFunc("GET /bank/resolve", auth(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("account_number") != "0001234567" || r.URL.Query().Get("bank_code") != "058" {
			reply(w, http.StatusUnprocessableEntity, false, "Could not resolve account name", nil)
			return
		}
		reply(w, http.StatusOK, true, "Account number resolved", map[string]any{"account_number": "0001234567", "account_name": "TEST ACCOUNT"})
	}))
	mux.HandleFunc("POST /transferrecipient", auth(func(w http.ResponseWriter, _ *http.Request) {
		reply(w, http.StatusCreated, true, "Recipient created", map[string]any{"recipient_code": "RCP_test"})
	}))
	mux.HandleFunc("POST /transfer", auth(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Reference string `json:"reference"`
			Amount    int64  `json:"amount"`
			Recipient string `json:"recipient"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		if in.Amount != 250_000 || in.Recipient != "RCP_test" {
			reply(w, http.StatusBadRequest, false, "bad transfer", nil)
			return
		}
		transfers[in.Reference] = "success"
		reply(w, http.StatusOK, true, "Transfer has been queued", map[string]any{"transfer_code": "TRF_test", "status": "pending"})
	}))
	mux.HandleFunc("GET /transfer/verify/{ref}", auth(func(w http.ResponseWriter, r *http.Request) {
		st, ok := transfers[r.PathValue("ref")]
		if !ok {
			reply(w, http.StatusNotFound, false, "Transfer not found", nil)
			return
		}
		reply(w, http.StatusOK, true, "Transfer retrieved", map[string]any{"status": st, "transfer_code": "TRF_test", "updatedAt": "2026-11-09T10:00:00.000Z"})
	}))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestPaystackAdapter(t *testing.T) {
	t.Parallel()
	if _, err := NewPaystack(PaystackConfig{SecretKey: "sk_live_abc"}); !errors.Is(err, ErrLiveKey) { // gitleaks:allow (not a real key)
		t.Fatalf("a live key was accepted: %v", err)
	}
	srv := fakePaystack(t)
	p, err := NewPaystack(PaystackConfig{SecretKey: "sk_test_abc", BaseURL: srv.URL}) // gitleaks:allow (not a real key)
	if err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()

	n, err := p.NameEnquiry(ctx, "058", "0001234567")
	if err != nil || n.Name != "TEST ACCOUNT" {
		t.Fatalf("name enquiry = %+v, %v", n, err)
	}
	if _, err := p.NameEnquiry(ctx, "058", "9999999999"); !errors.Is(err, ErrAccountNotFound) {
		t.Fatalf("unresolvable account: %v", err)
	}

	if r, err := p.Status(ctx, "NEM20261109AAAAAA"); err != nil || r.State != Unknown {
		t.Fatalf("status before sending = %+v, %v", r, err)
	}
	sub, err := p.Send(ctx, Payment{Reference: "NEM20261109AAAAAA", BankCode: "058", AccountNumber: "0001234567",
		AccountName: "TEST ACCOUNT", Amount: money.New(250_000, money.NGN), Narration: "Rent"})
	if err != nil || sub.PartnerReference != "TRF_test" {
		t.Fatalf("send = %+v, %v", sub, err)
	}
	// Paystack wants lowercase references; the adapter translates both ways.
	r, err := p.Status(ctx, "NEM20261109AAAAAA")
	if err != nil || r.State != Settled || r.PartnerReference != "TRF_test" {
		t.Fatalf("status = %+v, %v", r, err)
	}
}
