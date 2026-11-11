package cards

import (
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

// txLine reads the customer's history line behind an authorization.
func (f *fixture) txLine(id uuid.UUID) (status string, amount int64, entry *uuid.UUID, cardID *uuid.UUID, category string) {
	f.t.Helper()
	if err := f.pool.QueryRow(f.t.Context(), `SELECT status, amount_minor, entry_id, card_id, category FROM transactions WHERE id = $1`, id).
		Scan(&status, &amount, &entry, &cardID, &category); err != nil {
		f.t.Fatal(err)
	}
	return status, amount, entry, cardID, category
}

// settlementBalance is the bank's card settlement account in a currency.
func (f *fixture) settlementBalance(cur money.Currency) int64 {
	f.t.Helper()
	var bal int64
	if err := f.pool.QueryRow(f.t.Context(), `SELECT balance_minor FROM ledger_accounts WHERE kind = 'card_settlement' AND currency = $1`, string(cur)).Scan(&bal); err != nil {
		f.t.Fatal(err)
	}
	return bal
}

func (f *fixture) holdStatus(id uuid.UUID) string {
	f.t.Helper()
	var st string
	if err := f.pool.QueryRow(f.t.Context(), `SELECT status FROM account_holds WHERE id = $1`, id).Scan(&st); err != nil {
		f.t.Fatal(err)
	}
	return st
}

func TestAuthorizeWritesAPendingLineOnTheCustomersHistory(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	a, err := f.svc.Authorize(t.Context(), card.charge(naira(3_500), ChannelOnline))
	if err != nil || a.TransactionID == nil {
		t.Fatalf("authorize = %+v, %v", a, err)
	}
	status, amount, entry, cardID, category := f.txLine(*a.TransactionID)
	if status != "pending" || amount != 3_500_00 || entry != nil || cardID == nil || *cardID != card.card.ID || category != "food" {
		t.Fatalf("line = %s %d %v %v %s", status, amount, entry, cardID, category)
	}
	// A decline leaves no line: nothing was held and nothing is pending.
	d, err := f.svc.Authorize(t.Context(), card.charge(naira(50_000), ChannelOnline))
	if err != nil || d.Status != AuthDeclined || d.TransactionID != nil {
		t.Fatalf("decline = %+v, %v", d, err)
	}
}

func TestCaptureTurnsTheHoldIntoAPostingExactlyOnce(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	a, err := f.svc.Authorize(t.Context(), card.charge(naira(3_500), ChannelOnline))
	if err != nil {
		t.Fatal(err)
	}
	before := f.settlementBalance(money.NGN)

	got, err := f.svc.Capture(t.Context(), a.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != AuthSettled || got.SettledAt == nil || got.BillingMinor != 3_500_00 {
		t.Fatalf("captured = %+v", got)
	}
	ledgerBal, avail := f.available(c.ngn)
	if ledgerBal != 6_500_00 || avail != 6_500_00 {
		t.Fatalf("ledger %d available %d; the hold must become the debit, not stack on it", ledgerBal, avail)
	}
	if f.holdStatus(*a.HoldID) != "captured" {
		t.Fatalf("hold = %s", f.holdStatus(*a.HoldID))
	}
	if after := f.settlementBalance(money.NGN); after-before != 3_500_00 {
		t.Fatalf("card settlement account moved by %d", after-before)
	}
	status, amount, entry, _, _ := f.txLine(*a.TransactionID)
	if status != "completed" || amount != 3_500_00 || entry == nil {
		t.Fatalf("line = %s %d %v", status, amount, entry)
	}

	// The second capture, and a reversal after settlement, both find it closed.
	_, err = f.svc.Capture(t.Context(), a.ID, nil)
	wantProblem(t, err, "authorization_closed")
	_, err = f.svc.Reverse(t.Context(), a.ID)
	wantProblem(t, err, "authorization_closed")
	if l, _ := f.available(c.ngn); l != 6_500_00 {
		t.Fatalf("a second capture moved money: %d", l)
	}
}

func TestPartialCaptureChargesLessAndFreesTheRest(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	a, err := f.svc.Authorize(t.Context(), card.charge(naira(3_500), ChannelOnline))
	if err != nil {
		t.Fatal(err)
	}
	two := naira(2_000)
	got, err := f.svc.Capture(t.Context(), a.ID, &two)
	if err != nil {
		t.Fatal(err)
	}
	if got.AmountMinor != 2_000_00 || got.BillingMinor != 2_000_00 {
		t.Fatalf("captured %d / %d", got.AmountMinor, got.BillingMinor)
	}
	ledgerBal, avail := f.available(c.ngn)
	if ledgerBal != 8_000_00 || avail != 8_000_00 {
		t.Fatalf("ledger %d available %d; the unused part of the hold must come back", ledgerBal, avail)
	}
	if _, amount, _, _, _ := f.txLine(*a.TransactionID); amount != 2_000_00 {
		t.Fatalf("history line shows %d, want the captured amount", amount)
	}
}

func TestPartialCaptureOfAForeignChargeKeepsTheAgreedRate(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(20_000_000, 0)
	// $10.00 on a naira card bills ₦16,240.00 (the test rate card's sell rate).
	foreign := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	req := foreign.charge(money.New(10_00, money.USD), ChannelOnline)
	req.Merchant.Country = "US"
	if _, err := f.svc.UpdateControls(c.ctx, foreign.card.ID, Update{International: ptr(true)}); err != nil {
		t.Fatal(err)
	}
	a, err := f.svc.Authorize(t.Context(), req)
	if err != nil || a.Status != AuthAuthorized || a.BillingMinor != 16_240_00 {
		t.Fatalf("authorize = %+v, %v", a, err)
	}
	four := money.New(4_00, money.USD)
	got, err := f.svc.Capture(t.Context(), a.ID, &four)
	if err != nil {
		t.Fatal(err)
	}
	// 4/10 of ₦16,240.00 = ₦6,496.00 exactly.
	if got.AmountMinor != 4_00 || got.AmountCurrency != "USD" || got.BillingMinor != 6_496_00 {
		t.Fatalf("captured %d %s billed %d", got.AmountMinor, got.AmountCurrency, got.BillingMinor)
	}
	// An uneven share rounds up, to the bank's side: 1/3 of ₦100.00 is 3,333.33 kobo.
	third := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	b, err := f.svc.Authorize(t.Context(), third.charge(naira(100), ChannelOnline))
	if err != nil {
		t.Fatal(err)
	}
	one := money.New(33_33, money.NGN) // of 10,000 kobo
	got, err = f.svc.Capture(t.Context(), b.ID, &one)
	if err != nil || got.BillingMinor != 33_33 {
		t.Fatalf("same-currency partial = %+v, %v", got, err)
	}
}

func TestCaptureRefusesWhatTheMerchantMayNotDo(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	a, err := f.svc.Authorize(t.Context(), card.charge(naira(1_000), ChannelOnline))
	if err != nil {
		t.Fatal(err)
	}
	more, usd, zero := naira(1_001), money.New(1_00, money.USD), money.New(0, money.NGN)
	for name, amount := range map[string]*money.Money{"more than authorized": &more, "other currency": &usd, "zero": &zero} {
		if _, err := f.svc.Capture(t.Context(), a.ID, amount); err == nil {
			t.Errorf("%s: captured", name)
		}
	}
	if f.holdStatus(*a.HoldID) != "active" {
		t.Fatal("a refused capture closed the hold")
	}
	_, err = f.svc.Capture(t.Context(), uuid.New(), nil)
	wantProblem(t, err, "not_found")

	// A decline has no hold to settle or release.
	d, err := f.svc.Authorize(t.Context(), card.charge(naira(500_000), ChannelOnline))
	if err != nil || d.Status != AuthDeclined {
		t.Fatalf("decline = %+v, %v", d, err)
	}
	_, err = f.svc.Capture(t.Context(), d.ID, nil)
	wantProblem(t, err, "authorization_closed")
	_, err = f.svc.Reverse(t.Context(), d.ID)
	wantProblem(t, err, "authorization_closed")
}

func TestReverseReleasesTheHoldAndSettlesTheLineAsReversed(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	a, err := f.svc.Authorize(t.Context(), card.charge(naira(3_500), ChannelOnline))
	if err != nil {
		t.Fatal(err)
	}
	got, err := f.svc.Reverse(t.Context(), a.ID)
	if err != nil || got.Status != AuthReversed || got.SettledAt != nil {
		t.Fatalf("reverse = %+v, %v", got, err)
	}
	ledgerBal, avail := f.available(c.ngn)
	if ledgerBal != 10_000_00 || avail != 10_000_00 {
		t.Fatalf("ledger %d available %d", ledgerBal, avail)
	}
	if status, _, entry, _, _ := f.txLine(*a.TransactionID); status != "failed" || entry != nil {
		t.Fatalf("line = %s %v", status, entry)
	}
	if f.holdStatus(*a.HoldID) != "released" {
		t.Fatalf("hold = %s", f.holdStatus(*a.HoldID))
	}
	_, err = f.svc.Capture(t.Context(), a.ID, nil)
	wantProblem(t, err, "authorization_closed")
	_, err = f.svc.Reverse(t.Context(), a.ID)
	wantProblem(t, err, "authorization_closed")
	// A reversed charge no longer counts against a single-use card or a limit.
	if n, err := f.svc.q.CountCharges(t.Context(), card.card.ID); err != nil || n != 0 {
		t.Fatalf("charges = %d, %v", n, err)
	}
}

func TestSingleUseCardIsSpentByItsCaptureNotByItsReversal(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeSingleUse})
	a, err := f.svc.Authorize(t.Context(), card.charge(naira(1_000), ChannelOnline))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Reverse(t.Context(), a.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := f.svc.Get(c.ctx, card.card.ID); got.Status != StatusActive {
		t.Fatalf("a reversed single-use card is %s, want active", got.Status)
	}
	b, err := f.svc.Authorize(t.Context(), card.charge(naira(1_000), ChannelOnline))
	if err != nil || b.Status != AuthAuthorized {
		t.Fatalf("second try after a reversal = %+v, %v", b, err)
	}
	if _, err := f.svc.Capture(t.Context(), b.ID, nil); err != nil {
		t.Fatal(err)
	}
	if got, _ := f.svc.Get(c.ctx, card.card.ID); got.Status != StatusUsed {
		t.Fatalf("a captured single-use card is %s, want used", got.Status)
	}
	// Used, it is no longer a card a merchant can charge with a different outcome than a decline.
	d, err := f.svc.Authorize(t.Context(), card.charge(naira(10), ChannelOnline))
	if err != nil || d.Status != AuthDeclined || d.DeclineReason == nil || *d.DeclineReason != DeclineCardUsed {
		t.Fatalf("charge on a used card = %+v, %v", d, err)
	}
}

func TestLapsedHoldsAreReleasedBySweepAndCannotBeCaptured(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	old, err := f.svc.Authorize(t.Context(), card.charge(naira(3_000), ChannelOnline))
	if err != nil {
		t.Fatal(err)
	}
	f.clk.advance(HoldLifetime - time.Hour)
	fresh, err := f.svc.Authorize(t.Context(), card.charge(naira(2_000), ChannelOnline))
	if err != nil {
		t.Fatal(err)
	}
	// Nothing has lapsed yet.
	if n, err := f.svc.ExpireHolds(t.Context()); err != nil || n != 0 {
		t.Fatalf("early sweep = %d, %v", n, err)
	}
	f.clk.advance(2 * time.Hour) // the old hold is now an hour past its seven days; the fresh one is not
	_, err = f.svc.Capture(t.Context(), old.ID, nil)
	wantProblem(t, err, "authorization_expired")

	n, err := f.svc.ExpireHolds(t.Context())
	if err != nil || n != 1 {
		t.Fatalf("sweep = %d, %v; want exactly the lapsed one", n, err)
	}
	if n, err := f.svc.ExpireHolds(t.Context()); err != nil || n != 0 {
		t.Fatalf("second sweep = %d, %v", n, err)
	}
	ledgerBal, avail := f.available(c.ngn)
	if ledgerBal != 10_000_00 || avail != 8_000_00 {
		t.Fatalf("ledger %d available %d; only the fresh ₦2,000 stays held", ledgerBal, avail)
	}
	if status, _, _, _, _ := f.txLine(*old.TransactionID); status != "failed" {
		t.Fatalf("lapsed line = %s", status)
	}
	if status, _, _, _, _ := f.txLine(*fresh.TransactionID); status != "pending" {
		t.Fatalf("fresh line = %s", status)
	}
	// The fresh one still settles.
	if _, err := f.svc.Capture(t.Context(), fresh.ID, nil); err != nil {
		t.Fatal(err)
	}
}

func TestCaptureAndReverseRacingEndTheAuthorizationOnce(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	a, err := f.svc.Authorize(t.Context(), card.charge(naira(4_000), ChannelOnline))
	if err != nil {
		t.Fatal(err)
	}
	const racers = 8
	var wg sync.WaitGroup
	results := make([]error, racers)
	for i := range racers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if i%2 == 0 {
				_, results[i] = f.svc.Capture(t.Context(), a.ID, nil)
			} else {
				_, results[i] = f.svc.Reverse(t.Context(), a.ID)
			}
		}()
	}
	wg.Wait()
	won := 0
	for _, err := range results {
		if err == nil {
			won++
		}
	}
	if won != 1 {
		t.Fatalf("%d of %d racers ended the authorization, want exactly 1: %v", won, racers, results)
	}
	ledgerBal, avail := f.available(c.ngn)
	if ledgerBal != avail || (ledgerBal != 6_000_00 && ledgerBal != 10_000_00) {
		t.Fatalf("ledger %d available %d: money neither held nor consistently moved", ledgerBal, avail)
	}
}

func TestCardTransactionsListPendingSettledAndDeclinedNewestFirst(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00, 0)
	other := f.customer(10_000_00, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	var ids []uuid.UUID
	for _, n := range []int64{100, 200, 300, 400_000} { // the last is declined
		a, err := f.svc.Authorize(t.Context(), card.charge(naira(n), ChannelOnline))
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, a.ID)
		f.clk.advance(time.Minute)
	}
	if _, err := f.svc.Capture(t.Context(), ids[0], nil); err != nil {
		t.Fatal(err)
	}

	two := 2
	page1, info, err := f.svc.Transactions(c.ctx, card.card.ID, nil, &two)
	if err != nil || len(page1) != 2 || info.NextCursor == nil {
		t.Fatalf("page 1 = %d rows, cursor %v, %v", len(page1), info.NextCursor, err)
	}
	if page1[0].ID != ids[3] || page1[0].Status != AuthDeclined || page1[1].ID != ids[2] || page1[1].Status != AuthAuthorized {
		t.Fatalf("page 1 = %v %s, %v %s", page1[0].ID, page1[0].Status, page1[1].ID, page1[1].Status)
	}
	page2, info, err := f.svc.Transactions(c.ctx, card.card.ID, info.NextCursor, &two)
	if err != nil || len(page2) != 2 || info.NextCursor != nil {
		t.Fatalf("page 2 = %d rows, cursor %v, %v", len(page2), info.NextCursor, err)
	}
	if page2[0].ID != ids[1] || page2[1].ID != ids[0] || page2[1].Status != AuthSettled {
		t.Fatalf("page 2 = %v %v %s", page2[0].ID, page2[1].ID, page2[1].Status)
	}
	// Someone else's card is not found, not empty.
	_, _, err = f.svc.Transactions(other.ctx, card.card.ID, nil, nil)
	wantProblem(t, err, "not_found")
}
