package cards

import (
	"context"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/cards/cardsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// API adapts the service to the contract's strict server; the router embeds it. A nil *API
// answers 501.
type API struct {
	svc *Service
}

// NewAPI returns the card operations for the router.
func NewAPI(svc *Service) *API { return &API{svc: svc} }

// CardJSON is the contract's Card. The number is never part of it.
func CardJSON(c cardsdb.Card) api.Card {
	out := api.Card{
		Id: c.ID, AccountId: c.AccountID, Currency: api.CardCurrency(c.Currency), Type: api.CardType(c.Type),
		Status: api.CardStatus(c.Status), Network: api.CardNetwork(c.Network), Last4: c.Last4,
		ExpiryMonth: int(c.ExpiryMonth), ExpiryYear: int(c.ExpiryYear), NameOnCard: c.NameOnCard, Nickname: c.Nickname,
		Design: api.CardDesign(c.Design), FrozenByPanic: c.FrozenByPanic, Physical: c.Physical, CreatedAt: c.CreatedAt.UTC(),
		Controls: api.CardControls{OnlineEnabled: c.OnlineEnabled, InternationalEnabled: c.InternationalEnabled},
	}
	if c.SpendLimitMinor != nil && c.SpendLimitPeriod != nil {
		out.Controls.SpendLimit = &api.SpendLimit{
			Amount: accounts.Money(money.New(*c.SpendLimitMinor, money.Currency(c.Currency))),
			Period: api.SpendLimitPeriod(*c.SpendLimitPeriod),
		}
	}
	if c.MerchantID != nil && c.MerchantName != nil {
		out.Controls.MerchantLock = &api.MerchantLock{MerchantId: *c.MerchantID, MerchantName: *c.MerchantName}
	}
	return out
}

// parseLimit turns the contract's SpendLimit into the domain's.
func parseLimit(l *api.SpendLimit) (*SpendLimit, error) {
	if l == nil {
		return nil, nil //nolint:nilnil // no limit is a valid value
	}
	amount, err := money.ParseMinor(l.Amount.AmountMinor, string(l.Amount.Currency))
	if err != nil {
		return nil, problem.Validation(problem.Field("/spend_limit/amount", "invalid", "Enter a valid amount."))
	}
	return &SpendLimit{Amount: amount, Period: string(l.Period)}, nil
}

func parseLock(l *api.MerchantLock) *MerchantLock {
	if l == nil {
		return nil
	}
	return &MerchantLock{ID: l.MerchantId, Name: l.MerchantName}
}

// ListCards is GET /v1/cards.
func (a *API) ListCards(ctx context.Context, _ api.ListCardsRequestObject) (api.ListCardsResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	rows, err := a.svc.List(ctx)
	if err != nil {
		return nil, err
	}
	out := api.ListCards200JSONResponse{Data: make([]api.Card, len(rows))}
	for i, r := range rows {
		out.Data[i] = CardJSON(r)
	}
	return out, nil
}

// CreateCard is POST /v1/cards (signed, idempotent).
func (a *API) CreateCard(ctx context.Context, req api.CreateCardRequestObject) (api.CreateCardResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	b := req.Body
	limit, err := parseLimit(b.SpendLimit)
	if err != nil {
		return nil, err
	}
	in := IssueRequest{AccountID: b.AccountId, Type: string(b.Type), MerchantLock: parseLock(b.MerchantLock), SpendLimit: limit}
	if b.Nickname != nil {
		in.Nickname = *b.Nickname
	}
	if b.Design != nil {
		in.Design = string(*b.Design)
	}
	card, err := a.svc.Issue(ctx, in)
	if err != nil {
		return nil, err
	}
	return api.CreateCard201JSONResponse(CardJSON(card)), nil
}

// RequestPhysicalCard is POST /v1/cards/physical: printing and posting a card needs a
// manufacturing and delivery partner, so it is a Paid Feature (CARD-8).
func (a *API) RequestPhysicalCard(context.Context, api.RequestPhysicalCardRequestObject) (api.RequestPhysicalCardResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	return nil, problem.PaidFeatureRequired("physical_cards").
		WithDetail("Printing and delivering cards needs a card manufacturing partner (CARD-8).")
}

// GetCard is GET /v1/cards/{card_id}.
func (a *API) GetCard(ctx context.Context, req api.GetCardRequestObject) (api.GetCardResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	card, err := a.svc.Get(ctx, req.CardId)
	if err != nil {
		return nil, err
	}
	return api.GetCard200JSONResponse(CardJSON(card)), nil
}

// RevealCard is POST /v1/cards/{card_id}/reveal.
func (a *API) RevealCard(ctx context.Context, req api.RevealCardRequestObject) (api.RevealCardResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	s, err := a.svc.Reveal(ctx, req.CardId, req.Params.XStepUpToken)
	if err != nil {
		return nil, err
	}
	noStore := "no-store"
	return api.RevealCard200JSONResponse{
		Headers: api.RevealCard200ResponseHeaders{CacheControl: &noStore},
		Body: api.CardSecrets{
			CardId: s.CardID, Pan: s.PAN, Cvv: s.CVV, ExpiryMonth: s.Month, ExpiryYear: s.Year, VisibleUntil: s.VisibleUntil.UTC(),
		},
	}, nil
}

// UpdateCardControls is PATCH /v1/cards/{card_id}. The contract cannot tell an explicit null
// from an absent field once generated, so removing a control uses a value that means
// nothing otherwise: a spend limit of zero (a card that can never be charged is a frozen
// one), a merchant lock with an empty merchant ID, an empty nickname.
func (a *API) UpdateCardControls(ctx context.Context, req api.UpdateCardControlsRequestObject) (api.UpdateCardControlsResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	b := req.Body
	u := Update{Nickname: b.Nickname, Online: b.OnlineEnabled, International: b.InternationalEnabled}
	limit, err := parseLimit(b.SpendLimit)
	if err != nil {
		return nil, err
	}
	if limit != nil {
		if limit.Amount.Amount() == 0 {
			u.ClearLimit = true
		} else {
			u.SpendLimit = limit
		}
	}
	if b.MerchantLock != nil {
		if b.MerchantLock.MerchantId == "" {
			u.ClearLock = true
		} else {
			u.MerchantLock = parseLock(b.MerchantLock)
		}
	}
	card, err := a.svc.UpdateControls(ctx, req.CardId, u)
	if err != nil {
		return nil, err
	}
	return api.UpdateCardControls200JSONResponse(CardJSON(card)), nil
}

// FreezeCard is POST /v1/cards/{card_id}/freeze.
func (a *API) FreezeCard(ctx context.Context, req api.FreezeCardRequestObject) (api.FreezeCardResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	card, err := a.svc.Freeze(ctx, req.CardId)
	if err != nil {
		return nil, err
	}
	return api.FreezeCard200JSONResponse(CardJSON(card)), nil
}

// UnfreezeCard is POST /v1/cards/{card_id}/unfreeze.
func (a *API) UnfreezeCard(ctx context.Context, req api.UnfreezeCardRequestObject) (api.UnfreezeCardResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	var token string
	if req.Params.XStepUpToken != nil {
		token = *req.Params.XStepUpToken
	}
	card, err := a.svc.Unfreeze(ctx, req.CardId, token)
	if err != nil {
		return nil, err
	}
	return api.UnfreezeCard200JSONResponse(CardJSON(card)), nil
}

// TerminateCard is POST /v1/cards/{card_id}/terminate (idempotent).
func (a *API) TerminateCard(ctx context.Context, req api.TerminateCardRequestObject) (api.TerminateCardResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	card, err := a.svc.Terminate(ctx, req.CardId)
	if err != nil {
		return nil, err
	}
	return api.TerminateCard200JSONResponse(CardJSON(card)), nil
}

// ReplaceCard is POST /v1/cards/{card_id}/replace (signed, idempotent).
func (a *API) ReplaceCard(ctx context.Context, req api.ReplaceCardRequestObject) (api.ReplaceCardResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	card, err := a.svc.Replace(ctx, req.CardId)
	if err != nil {
		return nil, err
	}
	return api.ReplaceCard201JSONResponse(CardJSON(card)), nil
}

// TransactionJSON is the contract's CardTransaction for an authorization.
func TransactionJSON(r cardsdb.CardAuthorization) api.CardTransaction {
	out := api.CardTransaction{
		Id: r.ID, CardId: r.CardID, Amount: accounts.Money(moneyOf(r.AmountMinor, r.AmountCurrency)),
		BillingAmount: accounts.Money(moneyOf(r.BillingMinor, r.BillingCurrency)), Status: api.CardTransactionStatus(r.Status),
		TransactionId: r.TransactionID, AuthorizedAt: r.AuthorizedAt.UTC(),
	}
	out.Merchant.Id, out.Merchant.Name, out.Merchant.Mcc, out.Merchant.Country = &r.MerchantID, r.MerchantName, r.Mcc, r.Country
	if r.DeclineReason != nil {
		d := api.CardTransactionDeclineReason(*r.DeclineReason)
		out.DeclineReason = &d
	}
	if r.SettledAt != nil {
		t := r.SettledAt.UTC()
		out.SettledAt = &t
	}
	return out
}

// SimulateCardCharge is POST /v1/admin/simulators/merchant/charges (Merchant Simulator,
// ADM-11). It sends the processor the request a merchant's acquirer would, so a decline or a
// hold here is the real thing, not a canned answer.
func (a *API) SimulateCardCharge(ctx context.Context, req api.SimulateCardChargeRequestObject) (api.SimulateCardChargeResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	b := req.Body
	amount, err := money.ParseMinor(b.Amount.AmountMinor, string(b.Amount.Currency))
	if err != nil {
		return nil, problem.Validation(problem.Field("/amount", "invalid", "Enter a valid amount."))
	}
	if b.Pan == nil || b.Cvv == nil {
		return nil, problem.Validation(problem.Field("/pan", "required", "Card number and CVV are required."))
	}
	row, err := a.svc.Authorize(ctx, ChargeRequest{
		PAN: *b.Pan, CVV: *b.Cvv, Month: b.ExpiryMonth, Year: b.ExpiryYear, Amount: amount, Channel: string(b.Channel),
		Merchant: Merchant{ID: b.Merchant.Id, Name: b.Merchant.Name, MCC: b.Merchant.Mcc, Country: b.Merchant.Country},
	})
	if err != nil {
		return nil, err
	}
	// capture=true is a merchant that settles in the same breath (a card-present sale). A
	// declined charge has nothing to settle.
	if b.Capture != nil && *b.Capture && row.Status == AuthAuthorized {
		if row, err = a.svc.Capture(ctx, row.ID, nil); err != nil {
			return nil, err
		}
	}
	return api.SimulateCardCharge201JSONResponse(TransactionJSON(row)), nil
}

// CaptureSimulatedCharge is POST /v1/admin/simulators/merchant/charges/{authorization_id}/capture:
// the merchant settles an approved authorization, in full or for less (CARD-5).
func (a *API) CaptureSimulatedCharge(ctx context.Context, req api.CaptureSimulatedChargeRequestObject) (api.CaptureSimulatedChargeResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	var amount *money.Money
	if req.Body != nil && req.Body.Amount != nil {
		m, err := money.ParseMinor(req.Body.Amount.AmountMinor, string(req.Body.Amount.Currency))
		if err != nil {
			return nil, problem.Validation(problem.Field("/amount", "invalid", "Enter a valid amount."))
		}
		amount = &m
	}
	row, err := a.svc.Capture(ctx, req.AuthorizationId, amount)
	if err != nil {
		return nil, err
	}
	return api.CaptureSimulatedCharge200JSONResponse(TransactionJSON(row)), nil
}

// ReverseSimulatedCharge is POST /v1/admin/simulators/merchant/charges/{authorization_id}/reverse:
// the merchant cancels an approved authorization and the hold is released.
func (a *API) ReverseSimulatedCharge(ctx context.Context, req api.ReverseSimulatedChargeRequestObject) (api.ReverseSimulatedChargeResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	row, err := a.svc.Reverse(ctx, req.AuthorizationId)
	if err != nil {
		return nil, err
	}
	return api.ReverseSimulatedCharge200JSONResponse(TransactionJSON(row)), nil
}

// ListCardTransactions is GET /v1/cards/{card_id}/transactions.
func (a *API) ListCardTransactions(ctx context.Context, req api.ListCardTransactionsRequestObject) (api.ListCardTransactionsResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	rows, page, err := a.svc.Transactions(ctx, req.CardId, req.Params.Cursor, req.Params.Limit)
	if err != nil {
		return nil, err
	}
	out := api.ListCardTransactions200JSONResponse{Data: make([]api.CardTransaction, len(rows)), Page: page}
	for i, r := range rows {
		out.Data[i] = TransactionJSON(r)
	}
	return out, nil
}
