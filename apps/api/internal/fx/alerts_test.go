package fx

import (
	"testing"
	"time"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

func (f *fixture) outboxCount(topic string) int {
	f.t.Helper()
	var n int
	if err := f.pool.QueryRow(f.t.Context(), `SELECT count(*) FROM outbox_events WHERE topic = $1`, topic).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

// moveUSD makes the next hourly reading price the dollar at ngn naira.
func (f *fixture) moveUSD(ngn string) {
	f.t.Helper()
	f.svc.sources[0].(*fakeSource).set(snapshot("open_er_api", ngn, "0.8", "0.9"), nil)
	f.clk.advance(time.Hour)
	if err := f.svc.Ingest(f.t.Context()); err != nil {
		f.t.Fatal(err)
	}
}

func TestAnAlertFiresOnceWhenTheRateReachesItsTarget(t *testing.T) {
	f := newFixture(t)
	c := f.customer(0, 0)
	above, err := f.svc.CreateAlert(c.ctx, "USD-NGN", "above", "1650")
	if err != nil {
		t.Fatal(err)
	}
	below, err := f.svc.CreateAlert(c.ctx, "USD-NGN", "below", "1500")
	if err != nil {
		t.Fatal(err)
	}

	f.moveUSD("1640") // short of the target: nothing happens
	if n := f.outboxCount(topicAlert); n != 0 {
		t.Fatalf("alerts fired early: %d", n)
	}

	f.moveUSD("1660")
	if n := f.outboxCount(topicAlert); n != 1 {
		t.Fatalf("fired alerts = %d, want 1", n)
	}
	f.moveUSD("1700") // still above: the alert does not fire again
	if n := f.outboxCount(topicAlert); n != 1 {
		t.Fatalf("alert fired twice: %d events", n)
	}

	list, err := f.svc.Alerts(c.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].ID != below.ID || list[0].Status != "active" || list[1].ID != above.ID ||
		list[1].Status != "triggered" || list[1].TriggeredAt == nil {
		t.Fatalf("alerts = %+v", list)
	}
}

func TestAlertsAreValidatedCappedAndPrivate(t *testing.T) {
	f := newFixture(t)
	c, other := f.customer(0, 0), f.customer(0, 0)
	if _, err := f.svc.CreateAlert(c.ctx, "JPY-NGN", "above", "10"); err == nil {
		t.Fatal("unknown pair accepted")
	}
	if _, err := f.svc.CreateAlert(c.ctx, "USD-NGN", "above", "0"); err == nil {
		t.Fatal("zero target accepted")
	}
	first, err := f.svc.CreateAlert(c.ctx, "USD-NGN", "above", "1700")
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i < maxActiveAlerts; i++ {
		if _, err := f.svc.CreateAlert(c.ctx, "GBP-NGN", "below", "1500"); err != nil {
			t.Fatal(err)
		}
	}
	_, err = f.svc.CreateAlert(c.ctx, "EUR-NGN", "above", "2000")
	wantProblem(t, err, "too_many_alerts")

	wantProblem(t, f.svc.DeleteAlert(other.ctx, first.ID), problem.CodeNotFound)
	if err := f.svc.DeleteAlert(c.ctx, first.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.CreateAlert(c.ctx, "EUR-NGN", "above", "2000"); err != nil {
		t.Fatalf("a freed slot was refused: %v", err)
	}
}

func TestDemoInboundCreditsWalletsAndTakesEMTLOnLargeNaira(t *testing.T) {
	f := newFixture(t)
	c := f.customer(0, 0)

	_, err := f.svc.DemoInbound(c.ctx, InboundRequest{Account: c.usd, Amount: money.New(5_000_00, money.USD), SenderName: "Acme Inc"})
	wantProblem(t, err, problem.CodeForbidden)

	f.profs.setDemo(c.id)
	tx, err := f.svc.DemoInbound(c.ctx, InboundRequest{Account: c.usd, Amount: money.New(5_000_00, money.USD), SenderName: "Acme Inc", SenderBank: "Chase"})
	if err != nil {
		t.Fatal(err)
	}
	if tx.Direction != "credit" || tx.AmountMinor != 5_000_00 || f.balance(c.usd) != 5_000_00 {
		t.Fatalf("usd inbound: %+v balance %d", tx, f.balance(c.usd))
	}

	amount := money.New(50_000_00, money.NGN)
	if _, err := f.svc.DemoInbound(c.ctx, InboundRequest{Account: c.ngn, Amount: amount, SenderName: "Ada"}); err != nil {
		t.Fatal(err)
	}
	levy := limitRules{}.Rules().EMTL(amount).Amount()
	if levy <= 0 || f.balance(c.ngn) != amount.Amount()-levy {
		t.Fatalf("ngn balance %d, want %d less levy %d", f.balance(c.ngn), amount.Amount(), levy)
	}

	_, err = f.svc.DemoInbound(c.ctx, InboundRequest{Account: c.usd, Amount: money.New(100, money.NGN), SenderName: "X"})
	if err == nil {
		t.Fatal("currency mismatch accepted")
	}
}

func TestPnlReportsTheSpreadPerCurrencyAndEveryPositionBalance(t *testing.T) {
	f := newFixture(t)
	c := f.customer(0, 1_000_00)

	// The customer sells $100 at 1600 less 1.5%: ₦157,600 for ₦160,000 at mid, a ₦2,400 spread.
	q, err := f.svc.Quote(c.ctx, QuoteRequest{From: c.usd, To: c.ngn, Sell: usd(100_00)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Convert(c.ctx, q.ID); err != nil {
		t.Fatal(err)
	}
	// And buys $50 at 1600 plus 1.5%: pays ₦81,200 for ₦80,000 at mid, a ₦1,200 spread.
	q, err = f.svc.Quote(c.ctx, QuoteRequest{From: c.ngn, To: c.usd, Buy: usd(50_00)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Convert(c.ctx, q.ID); err != nil {
		t.Fatal(err)
	}

	r, err := f.svc.Pnl(t.Context(), time.Time{}, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Lines) != 3 {
		t.Fatalf("lines = %d, want one per currency", len(r.Lines))
	}
	usdLine := r.Lines[0]
	// Rounding the price up and the inverted 8-decimal rate leave the bank a few kobo more.
	const want = (2_400 + 1_200) * 100
	if usdLine.Currency != money.USD || usdLine.Conversions != 2 || usdLine.Bought.Amount() != 100_00 || usdLine.Sold.Amount() != 50_00 ||
		usdLine.Spread.Amount() < want || usdLine.Spread.Amount() > want+100 {
		t.Fatalf("usd line = %+v, want spread about %d", usdLine, want)
	}
	if usdLine.Position.Amount() != f.position(money.USD) || r.Spread.Amount() != usdLine.Spread.Amount() {
		t.Fatalf("position/total = %+v / %v", usdLine.Position, r.Spread)
	}
	if r.Lines[1].Conversions != 0 || r.Lines[1].Currency != money.GBP {
		t.Fatalf("gbp line = %+v", r.Lines[1])
	}

	// A period before any conversion is empty, and a backwards one is refused.
	old := f.clk.Now().AddDate(0, -3, 0)
	if r, err = f.svc.Pnl(t.Context(), old, old.AddDate(0, 0, 1)); err != nil || r.Spread.Amount() != 0 {
		t.Fatalf("old period = %+v, %v", r, err)
	}
	_, err = f.svc.Pnl(t.Context(), f.clk.Now(), old)
	wantProblem(t, err, problem.CodeValidationFailed)
}
