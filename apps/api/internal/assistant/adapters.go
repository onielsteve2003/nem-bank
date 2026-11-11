package assistant

import (
	"context"
	"fmt"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/cards"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers"
)

// BeneficiariesFrom adapts the transfers service. Search is the service's own: name, nickname,
// @nemtag, account number or bank. Only the ID and the card label leave this function; the
// model is told how many matched, never who.
func BeneficiariesFrom(t *transfers.Service) Beneficiaries { return beneficiaries{t} }

type beneficiaries struct{ t *transfers.Service }

func (b beneficiaries) Find(ctx context.Context, query string) ([]BeneficiaryRef, error) {
	limit := 5
	rows, _, err := b.t.ListBeneficiaries(ctx, nil, &query, nil, &limit)
	if err != nil {
		return nil, err
	}
	out := make([]BeneficiaryRef, len(rows))
	for i, r := range rows {
		label := r.Name
		if r.Nickname != nil && *r.Nickname != "" {
			label = fmt.Sprintf("%s (%s)", *r.Nickname, r.Name)
		}
		out[i] = BeneficiaryRef{ID: r.ID, Label: label}
	}
	return out, nil
}

// CardsFrom adapts the cards service.
func CardsFrom(c *cards.Service) Cards { return cardList{c} }

type cardList struct{ c *cards.Service }

func (l cardList) OpenCards(ctx context.Context) ([]CardRef, error) {
	rows, err := l.c.List(ctx)
	if err != nil {
		return nil, err
	}
	var out []CardRef
	for _, r := range rows {
		if r.Status != "active" {
			continue
		}
		ref := CardRef{ID: r.ID, Last4: r.Last4}
		if r.Nickname != nil {
			ref.Nickname = *r.Nickname
		}
		out = append(out, ref)
	}
	return out, nil
}
