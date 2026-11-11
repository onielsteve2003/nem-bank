package notify

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/mailer"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

func delivery(topic, aggregate string, payload any) jobs.Delivery {
	raw, _ := json.Marshal(payload)
	id, _ := uuid.NewV7()
	return jobs.Delivery{ID: id, Topic: topic, AggregateType: "x", AggregateID: aggregate, Payload: raw, CreatedAt: time.Now()}
}

func TestFormatMoney(t *testing.T) {
	for _, c := range []struct {
		minor int64
		cur   string
		want  string
	}{
		{500000, "NGN", "₦5,000"}, {1250, "USD", "$12.50"}, {123456789, "NGN", "₦1,234,567.89"},
		{5, "NGN", "₦0.05"}, {100000, "CAD", "CAD 1,000"},
	} {
		if got := formatMoney(c.minor, c.cur); got != c.want {
			t.Errorf("formatMoney(%d, %s) = %q, want %q", c.minor, c.cur, got, c.want)
		}
	}
}

func TestComposeTransferNotifiesBothSides(t *testing.T) {
	sender, receiver, tid := uuid.New(), uuid.New(), uuid.New()
	got, err := compose(delivery("transfer.completed", tid.String(), map[string]any{
		"transfer_id": tid, "user_id": sender, "recipient_user_id": receiver, "amount_minor": 500000, "currency": "NGN",
	}))
	if err != nil || len(got) != 2 {
		t.Fatalf("got %v, %v; want two drafts", got, err)
	}
	if got[0].UserID != sender || got[1].UserID != receiver || got[0].Role == got[1].Role {
		t.Errorf("drafts = %+v", got)
	}
	if !strings.Contains(got[1].Body, "₦5,000") {
		t.Errorf("receiver body %q lacks the amount", got[1].Body)
	}
	// An interbank transfer has no Nem recipient: one notification.
	got, _ = compose(delivery("transfer.completed", tid.String(), map[string]any{"transfer_id": tid, "user_id": sender, "amount_minor": 100, "currency": "NGN"}))
	if len(got) != 1 {
		t.Errorf("interbank transfer produced %d notifications, want 1", len(got))
	}
}

func TestComposeIgnoresDuressAndUnknownTopics(t *testing.T) {
	for _, topic := range []string{"security.duress_triggered", "nothing.here"} {
		got, err := compose(delivery(topic, uuid.NewString(), map[string]any{"user_id": uuid.New()}))
		if err != nil || len(got) != 0 {
			t.Errorf("%s: got %v, %v; want nothing", topic, got, err)
		}
	}
	for _, topic := range Topics {
		if topic == "security.duress_triggered" {
			t.Error("the duress alert must stay silent for the customer")
		}
	}
}

func TestComposeUserFromAggregateAndBadPayload(t *testing.T) {
	uid := uuid.New()
	got, err := compose(delivery("identity.device_bound", uid.String(), map[string]any{"platform": "ios"}))
	if err != nil || len(got) != 1 || got[0].UserID != uid || got[0].Category != "security" {
		t.Fatalf("got %+v, %v", got, err)
	}
	if _, err := compose(jobs.Delivery{Topic: "card.settled", Payload: []byte(`{"user_id": 5}`)}); err == nil {
		t.Error("a payload that does not parse must be an error, not dropped")
	}
}

func TestDefaultsKeepMarketingOff(t *testing.T) {
	d := Defaults()
	if m := d["marketing"]; m.InApp || m.Push || m.Email {
		t.Errorf("marketing defaults %+v; NOT-2 says off", m)
	}
	if len(d) != len(Categories) {
		t.Errorf("defaults cover %d categories, want %d", len(d), len(Categories))
	}
}

func TestExpoPushReportsDeadTokens(t *testing.T) {
	var sent []expoMessage
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &sent)
		_, _ = w.Write([]byte(`{"data":[{"status":"ok"},{"status":"error","details":{"error":"DeviceNotRegistered"}}]}`))
	}))
	defer srv.Close()
	dead, err := Expo{Endpoint: srv.URL}.Push(context.Background(), []string{"ExponentPushToken[a]", "ExponentPushToken[b]"}, "Hi", "There", "nembank://home")
	if err != nil || len(dead) != 1 || dead[0] != "ExponentPushToken[b]" {
		t.Fatalf("dead = %v, err = %v", dead, err)
	}
	if len(sent) != 2 || sent[0].Title != "Hi" || sent[0].Data["url"] != "nembank://home" {
		t.Errorf("sent = %+v", sent)
	}
}

type fakePusher struct {
	mu    sync.Mutex
	calls int
	dead  []string
}

func (f *fakePusher) Push(_ context.Context, _ []string, _, _, _ string) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return f.dead, nil
}

type fakeMail struct {
	mu   sync.Mutex
	sent []mailer.Message
}

func (f *fakeMail) Send(_ context.Context, m mailer.Message) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, m)
	return nil
}

func newUser(t *testing.T, pool *pgxpool.Pool, tag string) (uuid.UUID, uuid.UUID) {
	t.Helper()
	uid, dev := uuid.New(), uuid.New()
	if _, err := pool.Exec(t.Context(), `INSERT INTO users (id, first_name, last_name, email, phone, nemtag, date_of_birth,
		password_hash, terms_version, privacy_version, consent_accepted_at)
		VALUES ($1, 'Ada', 'User', $2, $3, $4, '1996-04-12', 'x', '2026-10', '2026-10', now())`,
		uid, tag+"@example.com", "+234806600"+fmt.Sprintf("%04d", len(tag)*1000+int(tag[len(tag)-1])), tag); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO devices (id, user_id, name, platform, public_key) VALUES ($1, $2, 'Phone', 'ios', $3)`,
		dev, uid, append([]byte(tag), make([]byte, 32-len(tag))...)); err != nil {
		t.Fatal(err)
	}
	return uid, dev
}

func asUser(uid, dev uuid.UUID) context.Context {
	return identity.WithPrincipal(context.Background(), identity.Principal{UserID: uid, SessionID: uuid.New(), DeviceID: dev})
}

func TestInboxAgainstPostgres(t *testing.T) {
	pool := testdb.New(t)
	push, mail := &fakePusher{}, &fakeMail{}
	svc, err := NewService(Config{Pool: pool, Mailer: mail, Pusher: push, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	ada, adaDev := newUser(t, pool, "ada1")
	bob, bobDev := newUser(t, pool, "bob2")
	ctx := asUser(ada, adaDev)
	if err := svc.RegisterPushToken(ctx, adaDev, "ExponentPushToken[ada]"); err != nil {
		t.Fatal(err)
	}
	// Someone else's device is refused, not silently stored.
	if err := svc.RegisterPushToken(ctx, bobDev, "ExponentPushToken[evil]"); err == nil {
		t.Fatal("registered a push token for another customer's device")
	}

	sub := svc.Subscriber()
	d := delivery("transfer.completed", uuid.NewString(), map[string]any{
		"transfer_id": uuid.New(), "user_id": ada, "recipient_user_id": bob, "amount_minor": 250000, "currency": "NGN",
	})
	if err := sub.Handle(t.Context(), d); err != nil {
		t.Fatal(err)
	}
	// The same event delivered again (at-least-once) changes nothing and sends nothing.
	if err := sub.Handle(t.Context(), d); err != nil {
		t.Fatal(err)
	}
	pg, err := svc.List(ctx, false, nil, nil)
	if err != nil || len(pg.Items) != 1 || pg.Unread != 1 {
		t.Fatalf("inbox = %+v, %v; want 1 unread", pg, err)
	}
	if push.calls != 1 || len(mail.sent) != 2 {
		t.Errorf("push calls = %d (want 1: only Ada has a token), emails = %d (want 2, one per side, once)", push.calls, len(mail.sent))
	}
	bobPage, _ := svc.List(asUser(bob, bobDev), false, nil, nil)
	if len(bobPage.Items) != 1 || bobPage.Items[0].Title != "Money received" {
		t.Fatalf("bob's inbox = %+v", bobPage.Items)
	}

	// Switching a category off stops new notifications in it entirely.
	prefs := Defaults()
	prefs["transactions"] = Channels{}
	if _, err := svc.SetPreferences(ctx, prefs); err != nil {
		t.Fatal(err)
	}
	if err := sub.Handle(t.Context(), delivery("transfer.failed", "x", map[string]any{"transfer_id": uuid.New(), "user_id": ada, "amount_minor": 1, "currency": "NGN"})); err != nil {
		t.Fatal(err)
	}
	if pg, _ = svc.List(ctx, false, nil, nil); len(pg.Items) != 1 {
		t.Errorf("a muted category still wrote %d notifications", len(pg.Items))
	}

	// Mark read: a stranger's ids match nothing; the owner's do.
	if err := svc.MarkRead(asUser(bob, bobDev), []uuid.UUID{pg.Items[0].ID}, false); err != nil {
		t.Fatal(err)
	}
	if pg, _ = svc.List(ctx, true, nil, nil); pg.Unread != 1 {
		t.Fatal("bob marked ada's notification as read")
	}
	if err := svc.MarkRead(ctx, nil, true); err != nil {
		t.Fatal(err)
	}
	if pg, _ = svc.List(ctx, true, nil, nil); pg.Unread != 0 || len(pg.Items) != 0 {
		t.Errorf("after mark-all-read: %+v", pg)
	}
}

func TestPagingAndPreferencesRules(t *testing.T) {
	pool := testdb.New(t)
	svc, err := NewService(Config{Pool: pool, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	uid, dev := newUser(t, pool, "cat3")
	ctx := asUser(uid, dev)
	sub := svc.Subscriber()
	for range 5 {
		if err := sub.Handle(t.Context(), delivery("statement.ready", "s", map[string]any{"user_id": uid})); err != nil {
			t.Fatal(err)
		}
	}
	seen := map[uuid.UUID]bool{}
	var cursor *string
	pages := 0
	for {
		limit := 2
		pg, err := svc.List(ctx, false, cursor, &limit)
		if err != nil {
			t.Fatal(err)
		}
		pages++
		for _, n := range pg.Items {
			if seen[n.ID] {
				t.Fatalf("notification %s on two pages", n.ID)
			}
			seen[n.ID] = true
		}
		if pg.Page.NextCursor == nil {
			break
		}
		cursor = pg.Page.NextCursor
	}
	if len(seen) != 5 || pages != 3 {
		t.Errorf("paged %d notifications over %d pages, want 5 over 3", len(seen), pages)
	}

	// Security cannot be switched off entirely (NOT-2).
	p := Defaults()
	p["security"] = Channels{}
	_, err = svc.SetPreferences(ctx, p)
	var pe *problem.Error
	if err == nil || !asProblem(err, &pe) {
		t.Fatalf("security off was accepted: %v", err)
	}
	p["security"] = Channels{Email: true}
	if _, err := svc.SetPreferences(ctx, p); err != nil {
		t.Errorf("one security channel should be enough: %v", err)
	}
	got, _ := svc.GetPreferences(ctx)
	if !got["security"].Email || got["security"].Push {
		t.Errorf("saved preferences came back as %+v", got["security"])
	}
}

func asProblem(err error, target **problem.Error) bool {
	pe, ok := err.(*problem.Error) //nolint:errorlint // the service returns the problem itself
	if ok {
		*target = pe
	}
	return ok
}

func TestComposeKYCOutcomes(t *testing.T) {
	uid := uuid.New()
	for _, c := range []struct {
		tier   int
		status string
		want   string
	}{
		{3, "approved", "You are now Tier 3"}, {2, "rejected", "Your Tier 3 upgrade was not approved"},
		{2, "resubmit", "We need a document again"}, {2, "not_started", "You are now Tier 2"}, {2, "pending_review", ""},
	} {
		got, err := compose(delivery("kyc.updated", uid.String(), map[string]any{"user_id": uid, "tier": c.tier, "status": c.status}))
		if err != nil {
			t.Fatal(err)
		}
		switch {
		case c.want == "" && len(got) != 0:
			t.Errorf("%s: a customer's own submission should not alert them, got %+v", c.status, got)
		case c.want != "" && (len(got) != 1 || got[0].Title != c.want || got[0].UserID != uid):
			t.Errorf("%d/%s: got %+v, want %q", c.tier, c.status, got, c.want)
		}
	}
}

func TestComposeDisputeAndSupport(t *testing.T) {
	uid, did, cid := uuid.New(), uuid.New(), uuid.New()
	for status, want := range map[string]string{
		"submitted": "", "withdrawn": "", "under_review": "Dispute under review", "awaiting_customer": "We need more from you",
		"resolved_refunded": "Dispute resolved: refunded", "resolved_declined": "Dispute closed",
	} {
		got, err := compose(delivery("dispute.updated", did.String(), map[string]any{"user_id": uid, "dispute_id": did, "case_number": "DSP-10000001", "status": status}))
		if err != nil {
			t.Fatal(err)
		}
		if (want == "") != (len(got) == 0) || (want != "" && got[0].Title != want) {
			t.Errorf("%s: got %+v, want %q", status, got, want)
		}
	}
	for sender, wantOne := range map[string]bool{"agent": true, "customer": false, "system": false} {
		got, _ := compose(delivery("support.message", cid.String(), map[string]any{"user_id": uid, "conversation_id": cid, "sender": sender}))
		if (len(got) == 1) != wantOne {
			t.Errorf("%s message: got %+v", sender, got)
		}
	}
}
