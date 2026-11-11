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
