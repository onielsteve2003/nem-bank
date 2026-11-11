package realtime

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

func newService(t *testing.T) (*Service, *Hub) {
	t.Helper()
	hub := NewHub(nil)
	svc, err := New(Config{Hub: hub, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	return svc, hub
}

func dial(t *testing.T, srv *httptest.Server, ticket string) (*websocket.Conn, error) {
	t.Helper()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + Path + "?ticket=" + ticket
	c, resp, err := websocket.Dial(t.Context(), url, nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	return c, err
}

func read(t *testing.T, c *websocket.Conn) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	_, b, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func event(kind string) Event {
	id, _ := uuid.NewV7()
	return Event{ID: id, Type: kind, OccurredAt: time.Now(), Data: map[string]string{"k": kind}}
}

func TestTicketIsSingleUseAndExpires(t *testing.T) {
	t.Parallel()
	now := time.Now()
	svc, _ := newService(t)
	svc.now = func() time.Time { return now }
	user := uuid.New()

	id, _, err := svc.Issue(user)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := svc.Redeem(id); !ok || got != user {
		t.Fatalf("redeem = %v, %v", got, ok)
	}
	if _, ok := svc.Redeem(id); ok {
		t.Fatal("a ticket was spent twice")
	}
	id, _, _ = svc.Issue(user)
	now = now.Add(TicketTTL + time.Second)
	if _, ok := svc.Redeem(id); ok {
		t.Fatal("an expired ticket was accepted")
	}
}

func TestSocketDeliversOnlyToItsOwnerAndResumes(t *testing.T) {
	t.Parallel()
	svc, hub := newService(t)
	r := gin.New()
	r.GET(Path, svc.Handler)
	srv := httptest.NewServer(r)
	defer srv.Close()

	ada, bola := uuid.New(), uuid.New()
	tk, _, _ := svc.Issue(ada)
	conn, err := dial(t, srv, tk)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.CloseNow() }()
	if _, err := dial(t, srv, tk); err == nil {
		t.Fatal("a spent ticket connected")
	}
	for range 50 { // the handler registers the connection just after the upgrade
		if hub.Connections(ada) == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	first, second := event("transfer.updated"), event("account.balance_updated")
	_ = hub.Publish(bola, event("transfer.updated")) // someone else's: never arrives
	_ = hub.Publish(ada, first)
	_ = hub.Publish(ada, first) // an outbox redelivery is ignored
	_ = hub.Publish(ada, second)
	if m := read(t, conn); m["id"] != first.ID.String() || m["type"] != "transfer.updated" {
		t.Fatalf("first = %v", m)
	}
	if m := read(t, conn); m["id"] != second.ID.String() {
		t.Fatalf("second = %v", m)
	}

	// ping answers; resume replays what came after the last event the app saw.
	ctx := t.Context()
	_ = conn.Write(ctx, websocket.MessageText, []byte(`{"type":"ping"}`))
	if m := read(t, conn); m["type"] != "pong" {
		t.Fatalf("ping = %v", m)
	}
	_ = conn.Write(ctx, websocket.MessageText, []byte(`{"type":"resume","last_event_id":"`+first.ID.String()+`"}`))
	if m := read(t, conn); m["id"] != second.ID.String() {
		t.Fatalf("resume = %v", m)
	}
}

func TestHistoryIsBoundedAndExpires(t *testing.T) {
	t.Parallel()
	now := time.Now()
	hub := NewHub(func() time.Time { return now })
	user := uuid.New()
	old := event("transfer.updated")
	old.OccurredAt = now.Add(-Retention - time.Hour)
	_ = hub.Publish(user, old)
	for range maxHistory + 20 {
		e := event("transfer.updated")
		e.OccurredAt = now
		_ = hub.Publish(user, e)
	}
	if got := len(hub.Missed(user, uuid.Nil)); got != maxHistory {
		t.Fatalf("kept %d events, want %d", got, maxHistory)
	}
}
