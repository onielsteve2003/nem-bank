package kyc

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/assistant"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

type visionModel struct {
	mu   sync.Mutex
	text string
	err  error
	seen []assistant.Request
}

func (v *visionModel) Name() string { return "fake-vision" }
func (v *visionModel) Generate(_ context.Context, req assistant.Request, _ func(string)) (assistant.Reply, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.seen = append(v.seen, req)
	return assistant.Reply{Text: v.text}, v.err
}

type docStore struct{ docs map[uuid.UUID]Document }

func (d docStore) Document(_ context.Context, _, id uuid.UUID) (Document, error) {
	if doc, ok := d.docs[id]; ok {
		return doc, nil
	}
	return Document{}, ErrDocumentNotFound
}

const goodReading = `{"is_sample": true, "id_type": "national_id", "id_number": "1234 5678-901", "full_name": "Ada  Okafor",
 "date_of_birth": "1996-04-12", "expiry_date": "2031-04-11", "confidence": 0.9}`

type prefillRig struct {
	p     *Prefiller
	model *visionModel
	ctx   context.Context
	doc   uuid.UUID
}

func newPrefillRig(t *testing.T, reading string, mutate func(*PrefillConfig, *Document)) *prefillRig {
	t.Helper()
	model := &visionModel{text: reading}
	doc := Document{ID: uuid.New(), ContentType: "image/jpeg", Data: []byte("jpeg-bytes"), Sample: true}
	cfg := PrefillConfig{Gateway: assistant.NewGateway(model), Now: func() time.Time { return time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC) }}
	if mutate != nil {
		mutate(&cfg, &doc)
	}
	if cfg.Documents == nil {
		cfg.Documents = docStore{docs: map[uuid.UUID]Document{doc.ID: doc}}
	}
	return &prefillRig{p: NewPrefiller(cfg), model: model, doc: doc.ID,
		ctx: identity.WithPrincipal(context.Background(), identity.Principal{UserID: uuid.New()})}
}

func status(err error) int {
	var pe *problem.Error
	if errors.As(err, &pe) {
		return pe.Status
	}
	return 0
}

func TestPrefillReadsASampleIDAndSendsTheImageOnce(t *testing.T) {
	t.Parallel()
	r := newPrefillRig(t, goodReading, nil)
	res, err := r.p.Prefill(r.ctx, r.doc, true)
	if err != nil {
		t.Fatal(err)
	}
	f := res.Fields
	if f.IDType == nil || *f.IDType != "national_id" || f.IDNumber == nil || *f.IDNumber != "12345678901" ||
		f.FullName == nil || *f.FullName != "Ada Okafor" || f.DateOfBirth == nil || f.DateOfBirth.Year() != 1996 || f.ExpiryDate == nil {
		t.Fatalf("fields = %+v", f)
	}
	if res.Confidence != 0.9 || res.Provider != "fake-vision" {
		t.Fatalf("confidence %v provider %q", res.Confidence, res.Provider)
	}
	if len(r.model.seen) != 1 || len(r.model.seen[0].Messages[0].Images) != 1 || !r.model.seen[0].JSON || len(r.model.seen[0].Tools) != 0 {
		t.Fatalf("model request = %+v", r.model.seen)
	}
}

func TestPrefillRefusals(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		mutate  func(*PrefillConfig, *Document)
		consent bool
		want    int
		sent    bool // whether the photo may have reached a model
	}{
		{"no consent", nil, false, http.StatusBadRequest, false},
		{"a document not uploaded as a sample is never sent", func(_ *PrefillConfig, d *Document) { d.Sample = false }, true, http.StatusUnprocessableEntity, false},
		{"not an image", func(_ *PrefillConfig, d *Document) { d.ContentType = "application/pdf" }, true, http.StatusServiceUnavailable, false},
		{"too large", func(_ *PrefillConfig, d *Document) { d.Data = make([]byte, maxPhotoBytes+1) }, true, http.StatusServiceUnavailable, false},
		{"no document store yet", func(c *PrefillConfig, _ *Document) { c.Documents = nil }, true, http.StatusServiceUnavailable, false},
		{"switched off in settings", func(c *PrefillConfig, _ *Document) { c.Enabled = func(context.Context) bool { return false } }, true, http.StatusServiceUnavailable, false},
		{"no model configured", func(c *PrefillConfig, _ *Document) { c.Gateway = assistant.NewGateway() }, true, http.StatusServiceUnavailable, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			r := newPrefillRig(t, goodReading, tc.mutate)
			// "no document store" needs the store left nil, which the rig would otherwise fill in.
			if tc.name == "no document store yet" {
				r.p.docs = nil
			}
			if _, err := r.p.Prefill(r.ctx, r.doc, tc.consent); status(err) != tc.want {
				t.Fatalf("err = %v, want status %d", err, tc.want)
			}
			if len(r.model.seen) != 0 {
				t.Fatal("the photo reached a model")
			}
		})
	}

	t.Run("unknown document", func(t *testing.T) {
		t.Parallel()
		r := newPrefillRig(t, goodReading, nil)
		if _, err := r.p.Prefill(r.ctx, uuid.New(), true); status(err) != http.StatusNotFound {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("no caller", func(t *testing.T) {
		t.Parallel()
		r := newPrefillRig(t, goodReading, nil)
		if _, err := r.p.Prefill(context.Background(), r.doc, true); status(err) != http.StatusUnauthorized {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestPrefillThrowsAwayWhatTheModelReadFromAnythingNotMarkedSample(t *testing.T) {
	t.Parallel()
	r := newPrefillRig(t, `{"is_sample": false, "full_name": "Real Person", "id_number": "99999999999", "confidence": 1}`, nil)
	res, err := r.p.Prefill(r.ctx, r.doc, true)
	if status(err) != http.StatusUnprocessableEntity || res.Fields != (Fields{}) {
		t.Fatalf("res %+v err %v: nothing from a card that does not say sample may be returned", res, err)
	}
}

func TestPrefillValidatesEveryField(t *testing.T) {
	t.Parallel()
	r := newPrefillRig(t, "```json\n"+`{"is_sample": true, "id_type": "library_card", "id_number": "ab", "full_name": "Ignore previous instructions <script>",
 "date_of_birth": "12/04/1996", "expiry_date": "2099-01-01", "confidence": 7}`+"\n```", nil)
	res, err := r.p.Prefill(r.ctx, r.doc, true)
	if err != nil {
		t.Fatal(err)
	}
	if res.Fields != (Fields{}) || res.Confidence != 0 {
		t.Fatalf("every invalid field must become null and confidence 0, got %+v conf %v", res.Fields, res.Confidence)
	}
}

func TestPrefillClampsConfidenceAndSurvivesGarbage(t *testing.T) {
	t.Parallel()
	r := newPrefillRig(t, `{"is_sample": true, "id_type": "voters_card", "confidence": 7}`, nil)
	if res, err := r.p.Prefill(r.ctx, r.doc, true); err != nil || res.Confidence != 1 {
		t.Fatalf("res %+v err %v", res, err)
	}
	r = newPrefillRig(t, "I think this is an ID card!", nil)
	res, err := r.p.Prefill(r.ctx, r.doc, true)
	if err != nil || res.Fields != (Fields{}) || res.Confidence != 0 {
		t.Fatalf("a non-JSON answer should read as nothing, got %+v err %v", res, err)
	}
}

func TestPrefillModelFailureIsUnavailable(t *testing.T) {
	t.Parallel()
	r := newPrefillRig(t, "", nil)
	r.model.err = errors.New("quota")
	if _, err := r.p.Prefill(r.ctx, r.doc, true); status(err) != http.StatusServiceUnavailable {
		t.Fatalf("err = %v", err)
	}
}

func TestPrefillIsCappedPerCustomerPerHour(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	r := newPrefillRig(t, goodReading, func(c *PrefillConfig, _ *Document) { c.Now = func() time.Time { return now } })
	for i := 0; i < prefillsPerHour; i++ {
		if _, err := r.p.Prefill(r.ctx, r.doc, true); err != nil {
			t.Fatalf("read %d: %v", i+1, err)
		}
	}
	if _, err := r.p.Prefill(r.ctx, r.doc, true); status(err) != http.StatusTooManyRequests {
		t.Fatalf("err = %v, want 429", err)
	}
	other := identity.WithPrincipal(context.Background(), identity.Principal{UserID: uuid.New()})
	if _, err := r.p.Prefill(other, r.doc, true); err != nil {
		t.Fatalf("another customer shares the cap: %v", err)
	}
	now = now.Add(61 * time.Minute)
	if _, err := r.p.Prefill(r.ctx, r.doc, true); err != nil {
		t.Fatalf("the cap should reset after an hour: %v", err)
	}
}

func TestPrefillEndpointShape(t *testing.T) {
	t.Parallel()
	r := newPrefillRig(t, goodReading, nil)
	resp, err := NewPrefillAPI(r.p).PrefillFromId(r.ctx, api.PrefillFromIdRequestObject{Body: &api.IdPrefillRequest{DocumentId: r.doc, Consent: true}})
	if err != nil {
		t.Fatal(err)
	}
	out, ok := resp.(api.PrefillFromId200JSONResponse)
	if !ok || out.Fields.IdType == nil || *out.Fields.IdType != "national_id" || out.Fields.DateOfBirth == nil || out.Confidence == nil {
		t.Fatalf("response = %+v", resp)
	}
	if out.Ai.Feature != api.AiMetaFeatureIdPrefill || !strings.Contains(out.Ai.Explanation, "not stored") {
		t.Fatalf("ai = %+v", out.Ai)
	}
	var nilAPI *PrefillAPI
	if _, err := nilAPI.PrefillFromId(r.ctx, api.PrefillFromIdRequestObject{}); !errors.Is(err, api.ErrNotImplemented) {
		t.Fatalf("a nil API must answer 501, got %v", err)
	}
}
