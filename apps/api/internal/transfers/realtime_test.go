package transfers

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/realtime"
)

func TestOutboxEventsReachBothPartiesAndThePayer(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu := f.customer("Tolu", "tolu", 5_000_000)
	ada := f.customer("Ada", "ada", 0)
	hub := realtime.NewHub(nil)
	sub := f.svc.RealtimeSubscriber(hub)

	v, err := f.svc.Create(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(1_000_000)})
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]any{"transfer_id": v.ID, "user_id": tolu.id, "recipient_user_id": ada.id})
	ev := jobs.Delivery{ID: uuid.New(), Topic: "transfer.completed", Payload: payload, CreatedAt: time.Now()}
	for range 2 { // at-least-once delivery: the second changes nothing
		if err := sub.Handle(t.Context(), ev); err != nil {
			t.Fatal(err)
		}
	}
	types := func(user uuid.UUID) []string {
		var out []string
		for _, b := range hub.Missed(user, uuid.Nil) {
			var m struct{ Type string }
			_ = json.Unmarshal(b, &m)
			out = append(out, m.Type)
		}
		return out
	}
	if got := types(tolu.id); len(got) != 2 || got[0] != "transfer.updated" || got[1] != "account.balance_updated" {
		t.Fatalf("sender got %v", got)
	}
	if got := types(ada.id); len(got) != 1 || got[0] != "account.balance_updated" {
		t.Fatalf("recipient got %v", got)
	}

	r, err := f.svc.CreateRequest(tolu.ctx, "ada", ngn(500_000), "Suya", 7)
	if err != nil {
		t.Fatal(err)
	}
	payload, _ = json.Marshal(map[string]any{"request_id": r.ID, "requester_id": tolu.id, "payer_id": ada.id})
	if err := sub.Handle(t.Context(), jobs.Delivery{ID: uuid.New(), Topic: "money_request.created", Payload: payload, CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if got := types(ada.id); len(got) != 2 || got[1] != "money_request.received" {
		t.Fatalf("payer got %v", got)
	}
}
