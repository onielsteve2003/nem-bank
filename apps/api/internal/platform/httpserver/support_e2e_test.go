package httpserver

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

// attachmentUpload posts a multipart file to path as the signed-up customer.
func attachmentUpload(t *testing.T, s *fxStack, path string, file []byte) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	fw, err := w.CreateFormFile("file", "receipt.png")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = fw.Write(file)
	_ = w.Close()
	req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, path, &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+s.user.AccessToken)
	rec := httptest.NewRecorder()
	s.h.ServeHTTP(rec, req)
	return rec
}

// TestSupportChatAndDisputesOverHTTP runs the help paths through the contract: a chat with an
// attachment, a signed file link (no bearer token, tamper-proof), and a dispute with its
// one-open-per-transaction rule.
func TestSupportChatAndDisputesOverHTTP(t *testing.T) {
	t.Parallel()
	s := newFXStack(t)
	tok := s.user.AccessToken
	ngn := call[api.AccountList](t, s.h, http.MethodGet, "/v1/accounts", tok, nil, http.StatusOK).Data[0]
	var txn uuid.UUID
	if err := pgx.BeginFunc(t.Context(), s.pool, func(tx pgx.Tx) error {
		src, err := ledger.SystemAccount(t.Context(), tx, ledger.KindDemoFunding, "NGN")
		if err != nil {
			return err
		}
		fund := money.New(50_000_00, money.NGN)
		if _, err := ledger.Post(t.Context(), tx, ledger.Entry{Kind: "demo_funding", Reference: "fund", Legs: []ledger.Leg{ledger.Debit(src.ID, fund), ledger.Credit(ngn.Id, fund)}}); err != nil {
			return err
		}
		amt := money.New(10_000_00, money.NGN)
		posted, err := ledger.Post(t.Context(), tx, ledger.Entry{Kind: "demo_funding", Reference: "seed", Legs: []ledger.Leg{ledger.Debit(ngn.Id, amt), ledger.Credit(src.ID, amt)}})
		if err != nil {
			return err
		}
		line, err := accounts.Record(t.Context(), tx, accounts.Line{
			UserID: s.user.User.Id, AccountID: ngn.Id, Type: "card_payment", Direction: "debit", Status: "completed", Amount: amt, Entry: &posted,
			Narration: "Shop", Reference: "ref-1", Category: "shopping", Counterparty: api.Counterparty{Name: "Shop"},
		})
		txn = line.ID
		return err
	}); err != nil {
		t.Fatal(err)
	}

	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 3000)...)
	up := attachmentUpload(t, s, "/v1/support/attachments", png)
	if up.Code != http.StatusCreated {
		t.Fatalf("upload = %d: %s", up.Code, up.Body)
	}
	att := decode[api.Attachment](t, up.Body.Bytes())
	if rec := attachmentUpload(t, s, "/v1/support/attachments", bytes.Repeat([]byte("plain text "), 300)); rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("a text upload = %d, want 415: %s", rec.Code, rec.Body)
	}

	// The signed link needs no token; a changed signature is a plain 404.
	file := httptest.NewRecorder()
	s.h.ServeHTTP(file, httptest.NewRequestWithContext(t.Context(), http.MethodGet, att.Url, nil))
	if file.Code != http.StatusOK || file.Header().Get("Content-Type") != "image/png" || !bytes.Equal(file.Body.Bytes(), png) {
		t.Fatalf("file link = %d %q", file.Code, file.Header().Get("Content-Type"))
	}
	bad := httptest.NewRecorder()
	s.h.ServeHTTP(bad, httptest.NewRequestWithContext(t.Context(), http.MethodGet, att.Url+"0", nil))
	if bad.Code != http.StatusNotFound {
		t.Fatalf("tampered link = %d", bad.Code)
	}

	conv := call[api.SupportConversation](t, s.h, http.MethodPost, "/v1/support/conversations", tok,
		map[string]any{"subject": "Missing money", "message": "Please help.", "transaction_id": txn}, http.StatusCreated)
	if conv.Status != api.SupportConversationStatusOpen {
		t.Fatalf("conversation = %+v", conv)
	}
	msg := call[api.SupportMessage](t, s.h, http.MethodPost, "/v1/support/conversations/"+conv.Id.String()+"/messages", tok,
		map[string]any{"body": "Here is the receipt.", "attachment_ids": []uuid.UUID{att.Id}}, http.StatusCreated)
	if len(msg.Attachments) != 1 {
		t.Fatalf("message = %+v", msg)
	}
	page := call[api.SupportMessagePage](t, s.h, http.MethodGet, "/v1/support/conversations/"+conv.Id.String()+"/messages?limit=2", tok, nil, http.StatusOK)
	if len(page.Data) != 2 || page.Page.NextCursor == nil || page.Data[0].Body != "Here is the receipt." {
		t.Fatalf("messages = %+v", page)
	}
	call[api.Problem](t, s.h, http.MethodGet, "/v1/support/conversations/"+uuid.NewString(), tok, nil, http.StatusNotFound)
	if list := call[api.SupportConversationList](t, s.h, http.MethodGet, "/v1/support/conversations", tok, nil, http.StatusOK); len(list.Data) != 1 {
		t.Fatalf("list = %+v", list)
	}

	// Disputes: raise, see it listed, the second open one is refused, the evidence upload works.
	d := call[api.Dispute](t, s.h, http.MethodPost, "/v1/disputes", tok,
		map[string]any{"transaction_id": txn, "reason": "unauthorised", "description": "I did not make this payment."}, http.StatusCreated)
	if d.Status != api.Submitted || d.CaseNumber == "" {
		t.Fatalf("dispute = %+v", d)
	}
	call[api.Problem](t, s.h, http.MethodPost, "/v1/disputes", tok,
		map[string]any{"transaction_id": txn, "reason": "other", "description": "Trying again for the same one."}, http.StatusConflict)
	ev := attachmentUpload(t, s, "/v1/disputes/"+d.Id.String()+"/evidence", png)
	if ev.Code != http.StatusCreated || len(decode[api.Dispute](t, ev.Body.Bytes()).Evidence) != 1 {
		t.Fatalf("evidence = %d: %s", ev.Code, ev.Body)
	}
	if got := call[api.DisputePage](t, s.h, http.MethodGet, "/v1/disputes", tok, nil, http.StatusOK); len(got.Data) != 1 {
		t.Fatalf("disputes = %+v", got)
	}
	w := call[api.Dispute](t, s.h, http.MethodPost, "/v1/disputes/"+d.Id.String()+"/withdraw", tok, nil, http.StatusOK)
	if w.Status != api.Withdrawn {
		t.Fatalf("withdrawn = %+v", w)
	}
	call[api.Problem](t, s.h, http.MethodPost, "/v1/disputes/"+d.Id.String()+"/withdraw", tok, nil, http.StatusConflict)
	call[api.Problem](t, s.h, http.MethodGet, "/v1/disputes/"+uuid.NewString(), tok, nil, http.StatusNotFound)
}
