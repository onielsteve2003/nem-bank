package httpserver

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
)

// multipartUpload posts the KYC upload form the way the app does.
func multipartUpload(t *testing.T, s *fxStack, kind string, file []byte) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	_ = w.WriteField("kind", kind)
	fw, err := w.CreateFormFile("file", "photo.jpg")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = fw.Write(file)
	_ = w.Close()
	req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/v1/kyc/documents", &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+s.user.AccessToken)
	rec := httptest.NewRecorder()
	s.h.ServeHTTP(rec, req)
	return rec
}

// TestKYCOverHTTP walks Tier 1 to a pending Tier 3 submission through the contract: the tiers
// screen, a BVN check, multipart uploads (the validator reads the form), and the submission.
func TestKYCOverHTTP(t *testing.T) {
	t.Parallel()
	s := newFXStack(t)
	tok := s.user.AccessToken

	o := call[api.KycOverview](t, s.h, http.MethodGet, "/v1/kyc", tok, nil, http.StatusOK)
	if o.Tier != 1 || len(o.Tiers) != 3 || o.LatestSubmission != nil {
		t.Fatalf("overview = %+v", o)
	}
	call[api.Problem](t, s.h, http.MethodGet, "/v1/kyc", "", nil, http.StatusUnauthorized)

	v := call[api.IdentityVerification](t, s.h, http.MethodPost, "/v1/kyc/identity", tok,
		map[string]any{"type": "bvn", "number": "22212345678", "date_of_birth": "1996-04-12"}, http.StatusOK)
	if !v.Verified || v.Tier != 2 || !v.Sandbox {
		t.Fatalf("verification = %+v", v)
	}
	call[api.Problem](t, s.h, http.MethodPost, "/v1/kyc/identity", tok, map[string]any{"type": "bvn", "number": "12"}, http.StatusBadRequest)

	photo := append([]byte{0xFF, 0xD8, 0xFF, 0xE0}, make([]byte, 3000)...)
	var ids []uuid.UUID
	for _, kind := range []string{"id_front", "selfie"} {
		rec := multipartUpload(t, s, kind, photo)
		if rec.Code != http.StatusCreated {
			t.Fatalf("upload %s = %d: %s", kind, rec.Code, rec.Body)
		}
		ids = append(ids, decode[api.KycDocument](t, rec.Body.Bytes()).Id)
	}
	if rec := multipartUpload(t, s, "id_front", bytes.Repeat([]byte("not an image "), 400)); rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("a text file = %d, want 415: %s", rec.Code, rec.Body)
	}

	sub := call[api.KycSubmission](t, s.h, http.MethodPost, "/v1/kyc/submissions", tok, map[string]any{
		"target_tier": 3, "id_type": "national_id", "id_number": "12345678901", "document_ids": ids,
		"address": map[string]any{"line1": "1 Marina", "city": "Lagos", "state": "Lagos", "country": "NG"},
	}, http.StatusCreated)
	if sub.Status != api.KycSubmissionStatusPendingReview {
		t.Fatalf("submission = %+v", sub)
	}
	call[api.Problem](t, s.h, http.MethodPost, "/v1/kyc/submissions", tok, map[string]any{
		"target_tier": 3, "id_type": "national_id", "id_number": "12345678901", "document_ids": ids,
		"address": map[string]any{"line1": "1 Marina", "city": "Lagos", "state": "Lagos", "country": "NG"},
	}, http.StatusConflict)
	if got := call[api.KycSubmission](t, s.h, http.MethodGet, "/v1/kyc/submissions/"+sub.Id.String(), tok, nil, http.StatusOK); got.Id != sub.Id {
		t.Fatalf("get submission = %+v", got)
	}
	call[api.Problem](t, s.h, http.MethodGet, "/v1/kyc/submissions/"+uuid.NewString(), tok, nil, http.StatusNotFound)
}

// TestNotificationsOverHTTP runs the inbox contract: events become notifications, the list
// pages and counts unread, read marks stick, and preferences refuse silencing security.
func TestNotificationsOverHTTP(t *testing.T) {
	t.Parallel()
	s := newFXStack(t)
	tok := s.user.AccessToken
	var uid uuid.UUID
	if err := s.pool.QueryRow(t.Context(), `SELECT id FROM users LIMIT 1`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	sub := s.note.Subscriber()
	for range 3 {
		raw := []byte(`{"user_id":"` + uid.String() + `"}`)
		id, _ := uuid.NewV7()
		if err := sub.Handle(t.Context(), jobs.Delivery{ID: id, Topic: "statement.ready", AggregateType: "statement", AggregateID: id.String(), Payload: raw}); err != nil {
			t.Fatal(err)
		}
	}

	page := call[api.NotificationPage](t, s.h, http.MethodGet, "/v1/notifications?limit=2", tok, nil, http.StatusOK)
	if len(page.Data) != 2 || page.UnreadCount != 3 || page.Page.NextCursor == nil {
		t.Fatalf("first page = %+v", page)
	}
	rest := call[api.NotificationPage](t, s.h, http.MethodGet, "/v1/notifications?limit=2&cursor="+*page.Page.NextCursor, tok, nil, http.StatusOK)
	if len(rest.Data) != 1 || rest.Page.NextCursor != nil {
		t.Fatalf("second page = %+v", rest)
	}
	call[api.Problem](t, s.h, http.MethodGet, "/v1/notifications?cursor=junk", tok, nil, http.StatusBadRequest)

	call[struct{}](t, s.h, http.MethodPost, "/v1/notifications/read", tok, map[string]any{"ids": []uuid.UUID{page.Data[0].Id}}, http.StatusNoContent)
	if un := call[api.NotificationPage](t, s.h, http.MethodGet, "/v1/notifications?unread_only=true", tok, nil, http.StatusOK); un.UnreadCount != 2 || len(un.Data) != 2 {
		t.Fatalf("unread = %+v", un)
	}
	call[struct{}](t, s.h, http.MethodPost, "/v1/notifications/read", tok, map[string]any{"all": true}, http.StatusNoContent)

	prefs := call[api.NotificationPreferences](t, s.h, http.MethodGet, "/v1/notifications/preferences", tok, nil, http.StatusOK)
	if prefs.Categories.Marketing.InApp || prefs.Categories.Marketing.Push || prefs.Categories.Marketing.Email {
		t.Fatalf("marketing should start off: %+v", prefs.Categories.Marketing)
	}
	prefs.Categories.Security = api.ChannelPreferences{}
	call[api.Problem](t, s.h, http.MethodPut, "/v1/notifications/preferences", tok, prefs, http.StatusBadRequest)
	prefs.Categories.Security = api.ChannelPreferences{Email: true}
	prefs.Categories.Marketing.Email = true
	saved := call[api.NotificationPreferences](t, s.h, http.MethodPut, "/v1/notifications/preferences", tok, prefs, http.StatusOK)
	if !saved.Categories.Marketing.Email {
		t.Fatalf("saved = %+v", saved)
	}

	// Push tokens belong to the caller's own live devices.
	call[struct{}](t, s.h, http.MethodPost, "/v1/notifications/push-tokens", tok,
		map[string]any{"device_id": s.user.Device.Id, "expo_push_token": "ExponentPushToken[abc123]"}, http.StatusNoContent)
	call[api.Problem](t, s.h, http.MethodPost, "/v1/notifications/push-tokens", tok,
		map[string]any{"device_id": uuid.New(), "expo_push_token": "ExponentPushToken[abc123]"}, http.StatusNotFound)
	call[struct{}](t, s.h, http.MethodDelete, "/v1/notifications/push-tokens/"+s.user.Device.Id.String(), tok, nil, http.StatusNoContent)
}
