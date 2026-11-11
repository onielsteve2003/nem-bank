package cards

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
)

func TestAPIControlsClearWithTheDocumentedValues(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	a := NewAPI(f.svc)
	c := f.customer(10_000_00, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard,
		SpendLimit: &SpendLimit{Amount: naira(1_000), Period: Daily}, MerchantLock: &MerchantLock{ID: "m1", Name: "Shop"}, Nickname: "Mine"})

	resp, err := a.UpdateCardControls(c.ctx, api.UpdateCardControlsRequestObject{CardId: card.card.ID, Body: &api.UpdateCardControlsJSONRequestBody{
		SpendLimit:   &api.SpendLimit{Amount: api.Money{AmountMinor: "0", Currency: "NGN"}, Period: api.SpendLimitPeriodDaily},
		MerchantLock: &api.MerchantLock{MerchantId: "", MerchantName: ""},
		Nickname:     ptr(""),
	}})
	if err != nil {
		t.Fatal(err)
	}
	got := api.Card(resp.(api.UpdateCardControls200JSONResponse))
	if got.Controls.SpendLimit != nil || got.Controls.MerchantLock != nil || got.Nickname != nil {
		t.Fatalf("controls after clearing = %+v nickname %v", got.Controls, got.Nickname)
	}
}

func TestAPISimulatorChargeAndRevealShapes(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	a := NewAPI(f.svc)
	c := f.customer(5_000_00, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})

	charge := func(minor string, capture bool) api.SimulateCardChargeRequestObject {
		body := api.SimulateCardChargeJSONRequestBody{
			Pan: &card.pan, Cvv: &card.cvv, ExpiryMonth: int(card.card.ExpiryMonth), ExpiryYear: int(card.card.ExpiryYear),
			Amount: api.Money{AmountMinor: minor, Currency: "NGN"}, Channel: api.Online, Capture: &capture,
		}
		body.Merchant.Id, body.Merchant.Name, body.Merchant.Mcc, body.Merchant.Country = "m1", "Shop", "5411", "NG"
		return api.SimulateCardChargeRequestObject{Body: &body}
	}
	resp, err := a.SimulateCardCharge(t.Context(), charge("300000", false))
	if err != nil {
		t.Fatal(err)
	}
	approved := api.CardTransaction(resp.(api.SimulateCardCharge201JSONResponse))
	if approved.Status != api.CardTransactionStatusAuthorized || approved.DeclineReason != nil || approved.SettledAt != nil ||
		approved.Amount.AmountMinor != "300000" || approved.BillingAmount.Currency != "NGN" || approved.Merchant.Name != "Shop" {
		t.Fatalf("approved = %+v", approved)
	}
	resp, err = a.SimulateCardCharge(t.Context(), charge("300000", false))
	if err != nil {
		t.Fatal(err)
	}
	declined := api.CardTransaction(resp.(api.SimulateCardCharge201JSONResponse))
	if declined.Status != api.CardTransactionStatusDeclined || declined.DeclineReason == nil ||
		*declined.DeclineReason != api.CardTransactionDeclineReasonInsufficientFunds {
		t.Fatalf("declined = %+v", declined)
	}
	// capture=true settles in the same call; the hold becomes a posting.
	resp, err = a.SimulateCardCharge(t.Context(), charge("100", true))
	if err != nil {
		t.Fatal(err)
	}
	sale := api.CardTransaction(resp.(api.SimulateCardCharge201JSONResponse))
	if sale.Status != api.CardTransactionStatusSettled || sale.SettledAt == nil || sale.TransactionId == nil {
		t.Fatalf("capture=true = %+v", sale)
	}
	// The pending ₦3,000 settles for less, then a second capture is a 409.
	cap2 := api.Money{AmountMinor: "200000", Currency: "NGN"}
	cr, err := a.CaptureSimulatedCharge(t.Context(), api.CaptureSimulatedChargeRequestObject{
		AuthorizationId: approved.Id, Body: &api.CaptureSimulatedChargeJSONRequestBody{Amount: &cap2},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := api.CardTransaction(cr.(api.CaptureSimulatedCharge200JSONResponse)); got.Status != api.CardTransactionStatusSettled || got.Amount.AmountMinor != "200000" {
		t.Fatalf("capture = %+v", got)
	}
	_, err = a.ReverseSimulatedCharge(t.Context(), api.ReverseSimulatedChargeRequestObject{AuthorizationId: approved.Id})
	wantProblem(t, err, "authorization_closed")
	list, err := a.ListCardTransactions(c.ctx, api.ListCardTransactionsRequestObject{CardId: card.card.ID})
	if err != nil {
		t.Fatal(err)
	}
	if got := list.(api.ListCardTransactions200JSONResponse); len(got.Data) != 3 || got.Data[0].Status != api.CardTransactionStatusSettled {
		t.Fatalf("list = %+v", got.Data)
	}

	f.steps.reset()
	rev, err := a.RevealCard(c.ctx, api.RevealCardRequestObject{CardId: card.card.ID, Params: api.RevealCardParams{XStepUpToken: "good"}})
	if err != nil {
		t.Fatal(err)
	}
	r := rev.(api.RevealCard200JSONResponse)
	if r.Headers.CacheControl == nil || *r.Headers.CacheControl != "no-store" || r.Body.Pan != card.pan || r.Body.Cvv != card.cvv {
		t.Fatalf("reveal = %+v", r)
	}
	// The card itself never carries the details, in any response shape.
	listed, err := a.ListCards(c.ctx, api.ListCardsRequestObject{})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(listed)
	if strings.Contains(string(raw), card.pan) || strings.Contains(string(raw), `"cvv"`) {
		t.Fatalf("card list leaks details: %s", raw)
	}
	if _, err := a.RequestPhysicalCard(c.ctx, api.RequestPhysicalCardRequestObject{}); err == nil {
		t.Fatal("physical cards were not refused")
	} else {
		wantProblem(t, err, "paid_feature_required")
	}
}
