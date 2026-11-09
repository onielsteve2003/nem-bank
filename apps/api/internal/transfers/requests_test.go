package transfers

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

func TestMoneyRequestsArePaidDeclinedCancelledOrExpire(t *testing.T) {
	t.Parallel()
	f := newClockFixture(t)
	tolu := f.customer("Tolu", "tolu", 0)
	ada := f.customer("Ada", "ada", 5_000_000)

	_, err := f.svc.CreateRequest(tolu.ctx, "@tolu", ngn(100), "", 7)
	wantProblem(t, err, "validation_failed", "")
	_, err = f.svc.CreateRequest(tolu.ctx, "nobody", ngn(100), "", 7)
	wantProblem(t, err, "not_found", "No Nem user is @nobody.")

	r, err := f.svc.CreateRequest(tolu.ctx, "ada", ngn(500_000), " Suya ", 7)
	if err != nil || r.Incoming || r.Payer.UserID != ada.id || r.Note != "Suya" || !r.ExpiresAt.Equal(f.now.AddDate(0, 0, 7)) {
		t.Fatalf("request = %+v, %v", r, err)
	}
	in, _, err := f.svc.ListRequests(ada.ctx, true, nil, nil, nil)
	if err != nil || len(in) != 1 || !in[0].Incoming || in[0].ID != r.ID {
		t.Fatalf("ada's inbox = %+v, %v", in, err)
	}
	if out, _, _ := f.svc.ListRequests(ada.ctx, false, nil, nil, nil); len(out) != 0 {
		t.Fatalf("ada sent none, lists %d", len(out))
	}
	// Only the payer pays.
	if _, err := f.svc.PayRequest(tolu.ctx, r.ID, tolu.account); !errors.Is(err, errRequestClosed) {
		t.Fatalf("requester pays: %v", err)
	}
	v, err := f.svc.PayRequest(ada.ctx, r.ID, ada.account)
	if err != nil || v.Status != "completed" || v.Narration != "Suya" || v.MoneyRequestID == nil || *v.MoneyRequestID != r.ID {
		t.Fatalf("paid = %+v, %v", v.Transfer, err)
	}
	if f.balance(tolu) != 500_000 || f.balance(ada) != 4_500_000 {
		t.Fatalf("balances %d, %d", f.balance(tolu), f.balance(ada))
	}
	got, _ := f.svc.GetRequest(tolu.ctx, r.ID)
	if got.Status != "paid" || got.TransferID == nil || *got.TransferID != v.ID || got.RespondedAt == nil {
		t.Fatalf("after paying = %+v", got.MoneyRequest)
	}
	if _, err := f.svc.PayRequest(ada.ctx, r.ID, ada.account); !errors.Is(err, errRequestClosed) {
		t.Fatalf("paid twice: %v", err)
	}

	d, _ := f.svc.CreateRequest(tolu.ctx, "@ada", ngn(100), "", 7)
	if _, err := f.svc.DeclineRequest(tolu.ctx, d.ID); !errors.Is(err, errRequestClosed) {
		t.Fatalf("requester declines: %v", err)
	}
	if got, err := f.svc.DeclineRequest(ada.ctx, d.ID); err != nil || got.Status != "declined" {
		t.Fatalf("declined = %+v, %v", got.MoneyRequest, err)
	}
	if _, err := f.svc.CancelRequest(tolu.ctx, d.ID); !errors.Is(err, errRequestClosed) {
		t.Fatalf("cancel a declined one: %v", err)
	}
	c, _ := f.svc.CreateRequest(tolu.ctx, "@ada", ngn(100), "", 7)
	if got, err := f.svc.CancelRequest(tolu.ctx, c.ID); err != nil || got.Status != "cancelled" {
		t.Fatalf("cancelled = %+v, %v", got.MoneyRequest, err)
	}

	e, _ := f.svc.CreateRequest(tolu.ctx, "@ada", ngn(100), "", 1)
	f.advance(25 * time.Hour)
	if got, _ := f.svc.GetRequest(ada.ctx, e.ID); got.Status != "expired" {
		t.Fatalf("after a day = %s", got.Status)
	}
	if _, err := f.svc.PayRequest(ada.ctx, e.ID, ada.account); !errors.Is(err, errRequestClosed) {
		t.Fatalf("pay an expired one: %v", err)
	}
	status := "pending"
	if pending, _, _ := f.svc.ListRequests(ada.ctx, true, &status, nil, nil); len(pending) != 0 {
		t.Fatalf("pending = %d", len(pending))
	}
}

func TestSplitBillsShareTrackAndRemind(t *testing.T) {
	t.Parallel()
	f := newClockFixture(t)
	tolu := f.customer("Tolu", "tolu", 0)
	ada := f.customer("Ada", "ada", 5_000_000)
	_ = f.customer("Bolu", "bolu", 0)

	for name, tc := range map[string]struct {
		n     NewSplit
		title string
	}{
		"twice":         {NewSplit{Title: "x", Total: ngn(100), Split: "equal", Participants: []Participant{{Nemtag: "ada"}, {Nemtag: "@ada"}}}, "Add each person once"},
		"yourself":      {NewSplit{Title: "x", Total: ngn(100), Split: "equal", Participants: []Participant{{Nemtag: "tolu"}}}, "Add each person once"},
		"no amount":     {NewSplit{Title: "x", Total: ngn(100), Split: "custom", Participants: []Participant{{Nemtag: "ada"}}}, "Give every person an amount"},
		"over":          {NewSplit{Title: "x", Total: ngn(100), Split: "custom", IncludeSelf: true, Participants: []Participant{{Nemtag: "ada", Amount: ptr(ngn(101))}}}, "The shares come to more than the total"},
		"not the total": {NewSplit{Title: "x", Total: ngn(100), Split: "custom", Participants: []Participant{{Nemtag: "ada", Amount: ptr(ngn(99))}}}, "The shares must add up to the total"},
	} {
		_, err := f.svc.CreateSplit(tolu.ctx, tc.n)
		if err == nil || !strings.Contains(err.Error(), tc.title) {
			t.Errorf("%s: %v, want %q", name, err, tc.title)
		}
	}

	// Equal with the creator in: ₦10,000.01 three ways, the creator keeps the odd kobo.
	v, err := f.svc.CreateSplit(tolu.ctx, NewSplit{Title: "Dinner", Total: ngn(1_000_001), Split: "equal", IncludeSelf: true,
		Participants: []Participant{{Nemtag: "ada"}, {Nemtag: "bolu"}}})
	if err != nil {
		t.Fatal(err)
	}
	j := SplitJSON(v)
	if len(j.Shares) != 3 || j.Shares[0].Amount.AmountMinor != "333335" || j.Shares[0].Status != "paid" ||
		j.Shares[1].Amount.AmountMinor != "333333" || j.PaidTotal.AmountMinor != "333335" {
		t.Fatalf("split = %+v", j)
	}
	if _, err := f.svc.PayRequest(ada.ctx, *j.Shares[1].MoneyRequestId, ada.account); err != nil {
		t.Fatal(err)
	}
	if got, _ := f.svc.GetSplit(tolu.ctx, v.ID); SplitJSON(got).PaidTotal.AmountMinor != "666668" {
		t.Fatalf("paid total = %s", SplitJSON(got).PaidTotal.AmountMinor)
	}
	if _, err := f.svc.GetSplit(ada.ctx, v.ID); !errors.Is(err, ErrSplitNotFound) {
		t.Fatalf("someone else's: %v", err)
	}

	// Reminders: once a day per person still to pay.
	if err := f.svc.RemindSplit(tolu.ctx, v.ID); err != nil {
		t.Fatal(err)
	}
	if n := f.count(`SELECT count(*) FROM outbox_events WHERE topic = 'money_request.reminded'`); n != 1 {
		t.Fatalf("reminded %d (only Bolu still owes)", n)
	}
	wantProblem(t, f.svc.RemindSplit(tolu.ctx, v.ID), "rate_limited", "")
	f.advance(24 * time.Hour)
	if err := f.svc.RemindSplit(tolu.ctx, v.ID); err != nil {
		t.Fatal(err)
	}
	if rows, _, err := f.svc.ListSplits(tolu.ctx, nil, nil); err != nil || len(rows) != 1 {
		t.Fatalf("list = %d, %v", len(rows), err)
	}
}

func TestPaymentLinksTakePaymentsFromOthers(t *testing.T) {
	t.Parallel()
	f := newClockFixture(t)
	tolu := f.customer("Tolu", "tolu", 0)
	ada := f.customer("Ada", "ada", 5_000_000)

	_, err := f.svc.CreateLink(tolu.ctx, NewLink{AccountID: tolu.account, Title: "Cake", AmountMode: "fixed"})
	if !errors.Is(err, errFixedNeedsAmt) {
		t.Fatalf("fixed without amount: %v", err)
	}
	fixed, err := f.svc.CreateLink(tolu.ctx, NewLink{AccountID: tolu.account, Title: " Cake ", AmountMode: "fixed", Amount: ptr(ngn(200_000))})
	if err != nil || fixed.Title != "Cake" || len(fixed.Slug) != 8 {
		t.Fatalf("link = %+v, %v", fixed, err)
	}
	pub, err := f.svc.GetPublicLink(t.Context(), fixed.Slug)
	if err != nil || pub.PayeeName != "Tolu Test" || pub.Status != "active" {
		t.Fatalf("public = %+v, %v", pub, err)
	}
	if _, err := f.svc.PayLink(tolu.ctx, fixed.Slug, tolu.account, nil, ""); !errors.Is(err, errOwnLink) {
		t.Fatalf("own link: %v", err)
	}
	// A fixed link charges its amount whatever the payer sends.
	v, err := f.svc.PayLink(ada.ctx, fixed.Slug, ada.account, ptr(ngn(1)), "")
	if err != nil || v.AmountMinor != 200_000 || v.Narration != "Cake" || v.PaymentLinkID == nil {
		t.Fatalf("paid = %+v, %v", v.Transfer, err)
	}
	got, _ := f.svc.GetLink(tolu.ctx, fixed.ID)
	if got.PaymentsCount != 1 || got.TotalReceivedMinor != 200_000 || f.balance(tolu) != 200_000 {
		t.Fatalf("takings = %d / %d, balance %d", got.PaymentsCount, got.TotalReceivedMinor, f.balance(tolu))
	}

	open, err := f.svc.CreateLink(tolu.ctx, NewLink{AccountID: tolu.account, Title: "Tips", AmountMode: "open", ExpiresAt: ptr(f.now.Add(time.Hour))})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.PayLink(ada.ctx, open.Slug, ada.account, nil, ""); !errors.Is(err, errOpenNeedsAmt) {
		t.Fatalf("open without amount: %v", err)
	}
	if v, err := f.svc.PayLink(ada.ctx, open.Slug, ada.account, ptr(ngn(30_000)), "for you"); err != nil || v.Narration != "for you" {
		t.Fatalf("open pay = %+v, %v", v.Transfer, err)
	}
	inactive := "inactive"
	if _, err := f.svc.UpdateLink(tolu.ctx, fixed.ID, nil, nil, &inactive); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.PayLink(ada.ctx, fixed.Slug, ada.account, nil, ""); !errors.Is(err, errLinkClosed) {
		t.Fatalf("inactive link: %v", err)
	}
	f.advance(time.Hour)
	if l, _ := f.svc.GetLink(tolu.ctx, open.ID); f.svc.LinkJSON(l).Status != "expired" {
		t.Fatalf("expired link shows %s", f.svc.LinkJSON(l).Status)
	}
	if _, err := f.svc.UpdateLink(tolu.ctx, open.ID, ptr("New"), nil, nil); !errors.Is(err, errLinkExpired) {
		t.Fatalf("edit expired: %v", err)
	}
	if _, err := f.svc.GetLink(ada.ctx, fixed.ID); !errors.Is(err, ErrLinkNotFound) {
		t.Fatalf("someone else's: %v", err)
	}
}

func TestQRCodesAreSignedAndExpire(t *testing.T) {
	t.Parallel()
	f := newClockFixture(t)
	tolu := f.customer("Tolu", "tolu", 0)
	ada := f.customer("Ada", "ada", 0)

	open, err := f.svc.MyQR(tolu.ctx, tolu.account, nil)
	if err != nil || open.ExpiresAt != nil || !strings.HasPrefix(open.Payload, "nem1.") {
		t.Fatalf("open = %+v, %v", open, err)
	}
	d, err := f.svc.DecodeQR(ada.ctx, open.Payload)
	if err != nil || !d.Valid || d.Payee.Name != "Tolu Test" || d.Amount != nil || d.Account != tolu.number {
		t.Fatalf("decoded = %+v, %v", d, err)
	}
	fixed, err := f.svc.MyQR(tolu.ctx, tolu.account, ptr(money.New(250_000, money.NGN)))
	if err != nil || fixed.ExpiresAt == nil {
		t.Fatalf("fixed = %+v, %v", fixed, err)
	}
	if d, _ := f.svc.DecodeQR(ada.ctx, fixed.Payload); !d.Valid || d.Amount.Amount() != 250_000 {
		t.Fatalf("fixed decoded = %+v", d)
	}

	// Someone swaps in their own account number: the signature no longer matches.
	parts := strings.Split(open.Payload, ".")
	forged := base64.RawURLEncoding.EncodeToString([]byte(`{"acct":"` + ada.number + `","kid":"qr1"}`))
	for payload, want := range map[string]string{
		parts[0] + "." + forged + "." + parts[2]: "bad_signature",
		"https://example.com/pay":                "not_nem_qr",
		"nem1.!!!.x":                             "not_nem_qr",
	} {
		if d, err := f.svc.DecodeQR(ada.ctx, payload); err != nil || d.Valid || d.Reason != want {
			t.Errorf("%q = %+v, %v; want %s", payload, d, err, want)
		}
	}
	f.advance(QRFixedTTL)
	if d, _ := f.svc.DecodeQR(ada.ctx, fixed.Payload); d.Valid || d.Reason != "expired" {
		t.Fatalf("after 15 minutes = %+v", d)
	}
	if d, _ := f.svc.DecodeQR(ada.ctx, open.Payload); !d.Valid {
		t.Fatal("open codes do not expire")
	}
}
