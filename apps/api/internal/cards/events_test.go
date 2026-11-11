package cards

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/realtime"
)

// outbox is what the card domain has announced, oldest first.
func (f *fixture) outbox() []jobs.Delivery {
	f.t.Helper()
	rows, err := f.pool.Query(f.t.Context(), `SELECT id, topic, aggregate_type, aggregate_id, payload, created_at FROM outbox_events
		WHERE topic LIKE 'card.%' ORDER BY created_at, id`)
	if err != nil {
		f.t.Fatal(err)
	}
	defer rows.Close()
	var out []jobs.Delivery
	for rows.Next() {
		var d jobs.Delivery
		if err := rows.Scan(&d.ID, &d.Topic, &d.AggregateType, &d.AggregateID, &d.Payload, &d.CreatedAt); err != nil {
			f.t.Fatal(err)
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		f.t.Fatal(err)
	}
	return out
}

func topics(ds []jobs.Delivery) []string {
	out := make([]string, len(ds))
	for i, d := range ds {
		out[i] = d.Topic
	}
	return out
}

func TestEveryOutcomeIsAnnouncedOnceWithTheMoneyItMoved(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard, Nickname: "Food"})

	// Details that match no card are an error, and nothing is announced.
	bad := card.charge(naira(100), ChannelOnline)
	bad.CVV = wrongCVV(card.cvv)
	if _, err := f.svc.Authorize(t.Context(), bad); err == nil {
		t.Fatal("bad CVV authorized")
	}
	if got := f.outbox(); len(got) != 0 {
		t.Fatalf("a refused request announced %v", topics(got))
	}

	a, err := f.svc.Authorize(t.Context(), card.charge(naira(3_000), ChannelOnline)) // approved
	if err != nil {
		t.Fatal(err)
	}
	d, err := f.svc.Authorize(t.Context(), card.charge(naira(900_000), ChannelOnline)) // declined: funds
	if err != nil {
		t.Fatal(err)
	}
	b, err := f.svc.Authorize(t.Context(), card.charge(naira(1_000), ChannelOnline))
	if err != nil {
		t.Fatal(err)
	}
	two := naira(2_000)
	if _, err := f.svc.Capture(t.Context(), a.ID, &two); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Reverse(t.Context(), b.ID); err != nil {
		t.Fatal(err)
	}
	// Closed authorizations announce nothing more.
	_, _ = f.svc.Capture(t.Context(), a.ID, nil)
	_, _ = f.svc.Reverse(t.Context(), b.ID)

	got := f.outbox()
	want := []string{TopicAuthorized, TopicDeclined, TopicAuthorized, TopicSettled, TopicReversed}
	if len(got) != len(want) {
		t.Fatalf("announced %v, want %v", topics(got), want)
	}
	for i := range want {
		if got[i].Topic != want[i] {
			t.Fatalf("announced %v, want %v", topics(got), want)
		}
	}

	var declined, settled Event
	if err := json.Unmarshal(got[1].Payload, &declined); err != nil {
		t.Fatal(err)
	}
	if declined.AuthorizationID != d.ID || declined.DeclineReason == nil || *declined.DeclineReason != DeclineInsufficientFunds ||
		declined.TransactionID != nil || declined.UserID != c.id || declined.CardLast4 != card.card.Last4 {
		t.Fatalf("declined event = %+v", declined)
	}
	if err := json.Unmarshal(got[3].Payload, &settled); err != nil {
		t.Fatal(err)
	}
	// The settled event carries what was really charged, the figure a round-up works from.
	if settled.AuthorizationID != a.ID || settled.Status != AuthSettled || settled.BillingMinor != 2_000_00 || settled.AmountMinor != 2_000_00 ||
		settled.Category != "food" || settled.MerchantName != "Chicken Republic" || settled.CardNickname == nil || *settled.CardNickname != "Food" ||
		settled.TransactionID == nil || settled.AccountID != c.ngn {
		t.Fatalf("settled event = %+v", settled)
	}
	if got[3].AggregateType != "card_authorization" || got[3].AggregateID != a.ID.String() {
		t.Fatalf("aggregate = %s %s", got[3].AggregateType, got[3].AggregateID)
	}
}

func TestLapsedHoldsAnnounceAReversal(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	if _, err := f.svc.Authorize(t.Context(), card.charge(naira(500), ChannelOnline)); err != nil {
		t.Fatal(err)
	}
	f.clk.advance(HoldLifetime + time.Minute)
	if n, err := f.svc.ExpireHolds(t.Context()); err != nil || n != 1 {
		t.Fatalf("sweep = %d, %v", n, err)
	}
	if got := topics(f.outbox()); len(got) != 2 || got[1] != TopicReversed {
		t.Fatalf("announced %v", got)
	}
}

func TestRealtimeSubscriberTellsTheAppTheChargeAndItsBalance(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	a, err := f.svc.Authorize(t.Context(), card.charge(naira(3_000), ChannelOnline))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Authorize(t.Context(), card.charge(naira(900_000), ChannelOnline)); err != nil { // declined
		t.Fatal(err)
	}
	if _, err := f.svc.Capture(t.Context(), a.ID, nil); err != nil {
		t.Fatal(err)
	}
	hub := realtime.NewHub(nil)
	sub := f.svc.RealtimeSubscriber(hub)
	events := f.outbox() // authorized, declined, settled
	for _, ev := range events {
		for range 2 { // at-least-once delivery: the second changes nothing
			if err := sub.Handle(t.Context(), ev); err != nil {
				t.Fatal(err)
			}
		}
	}
	var types []string
	var charge struct {
		Type string
		Data struct {
			ID     uuid.UUID
			Status string
		}
	}
	for _, b := range hub.Missed(c.id, uuid.Nil) {
		var m struct{ Type string }
		_ = json.Unmarshal(b, &m)
		types = append(types, m.Type)
		if m.Type == "card.authorization" {
			if err := json.Unmarshal(b, &charge); err != nil {
				t.Fatal(err)
			}
		}
	}
	// authorized: charge + balance; declined: charge only; settled: charge + balance.
	want := []string{"card.authorization", "account.balance_updated", "card.authorization", "card.authorization", "account.balance_updated"}
	if len(types) != len(want) {
		t.Fatalf("pushed %v, want %v", types, want)
	}
	for i := range want {
		if types[i] != want[i] {
			t.Fatalf("pushed %v, want %v", types, want)
		}
	}
	// Every push reads the authorization as it is now, so the first announcement of a charge
	// that has since settled already shows it settled; the last push is the settled one.
	if charge.Data.ID != a.ID || charge.Data.Status != AuthSettled {
		t.Fatalf("last charge push = %+v", charge)
	}
}
