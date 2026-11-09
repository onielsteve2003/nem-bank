package transfers

import (
	"context"
	"fmt"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

func parseMoney(m api.Money) (money.Money, error) {
	v, err := money.ParseMinor(m.AmountMinor, string(m.Currency))
	if err != nil {
		return v, fmt.Errorf("amount passed validation but not parsing: %w", err)
	}
	return v, nil
}

func parseOptionalMoney(m *api.Money) (*money.Money, error) {
	if m == nil {
		return nil, nil //nolint:nilnil // no amount is a valid value
	}
	v, err := parseMoney(*m)
	return &v, err
}

// ListMoneyRequests is GET /v1/money-requests.
func (a *API) ListMoneyRequests(ctx context.Context, req api.ListMoneyRequestsRequestObject) (api.ListMoneyRequestsResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	p := req.Params
	rows, page, err := a.svc.ListRequests(ctx, p.Direction == api.Incoming, (*string)(p.Status), p.Cursor, p.Limit)
	if err != nil {
		return nil, err
	}
	out := api.ListMoneyRequests200JSONResponse{Data: make([]api.MoneyRequest, len(rows)), Page: page}
	for i, r := range rows {
		out.Data[i] = RequestJSON(r)
	}
	return out, nil
}

// CreateMoneyRequest is POST /v1/money-requests.
func (a *API) CreateMoneyRequest(ctx context.Context, req api.CreateMoneyRequestRequestObject) (api.CreateMoneyRequestResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	b := req.Body
	amount, err := parseMoney(b.Amount)
	if err != nil {
		return nil, err
	}
	note, days := "", 7
	if b.Note != nil {
		note = *b.Note
	}
	if b.ExpiresInDays != nil {
		days = *b.ExpiresInDays
	}
	r, err := a.svc.CreateRequest(ctx, b.PayerNemtag, amount, note, days)
	if err != nil {
		return nil, err
	}
	return api.CreateMoneyRequest201JSONResponse(RequestJSON(r)), nil
}

// GetMoneyRequest is GET /v1/money-requests/{request_id}.
func (a *API) GetMoneyRequest(ctx context.Context, req api.GetMoneyRequestRequestObject) (api.GetMoneyRequestResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	r, err := a.svc.GetRequest(ctx, req.RequestId)
	if err != nil {
		return nil, err
	}
	return api.GetMoneyRequest200JSONResponse(RequestJSON(r)), nil
}

// PayMoneyRequest is POST /v1/money-requests/{request_id}/pay (signed, idempotent).
func (a *API) PayMoneyRequest(ctx context.Context, req api.PayMoneyRequestRequestObject) (api.PayMoneyRequestResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	t, err := transferResponse(a.svc.PayRequest(ctx, req.RequestId, req.Body.SourceAccountId))
	if err != nil {
		return nil, err
	}
	return api.PayMoneyRequest201JSONResponse(t), nil
}

// DeclineMoneyRequest is POST /v1/money-requests/{request_id}/decline.
func (a *API) DeclineMoneyRequest(ctx context.Context, req api.DeclineMoneyRequestRequestObject) (api.DeclineMoneyRequestResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	r, err := a.svc.DeclineRequest(ctx, req.RequestId)
	if err != nil {
		return nil, err
	}
	return api.DeclineMoneyRequest200JSONResponse(RequestJSON(r)), nil
}

// CancelMoneyRequest is POST /v1/money-requests/{request_id}/cancel.
func (a *API) CancelMoneyRequest(ctx context.Context, req api.CancelMoneyRequestRequestObject) (api.CancelMoneyRequestResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	r, err := a.svc.CancelRequest(ctx, req.RequestId)
	if err != nil {
		return nil, err
	}
	return api.CancelMoneyRequest200JSONResponse(RequestJSON(r)), nil
}

// ListSplitBills is GET /v1/split-bills.
func (a *API) ListSplitBills(ctx context.Context, req api.ListSplitBillsRequestObject) (api.ListSplitBillsResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	rows, page, err := a.svc.ListSplits(ctx, req.Params.Cursor, req.Params.Limit)
	if err != nil {
		return nil, err
	}
	out := api.ListSplitBills200JSONResponse{Data: make([]api.SplitBill, len(rows)), Page: page}
	for i, v := range rows {
		out.Data[i] = SplitJSON(v)
	}
	return out, nil
}

// CreateSplitBill is POST /v1/split-bills.
func (a *API) CreateSplitBill(ctx context.Context, req api.CreateSplitBillRequestObject) (api.CreateSplitBillResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	b := req.Body
	total, err := parseMoney(b.Total)
	if err != nil {
		return nil, err
	}
	n := NewSplit{Title: b.Title, Total: total, Split: string(b.Split), IncludeSelf: b.IncludeSelf == nil || *b.IncludeSelf}
	for _, p := range b.Participants {
		amt, err := parseOptionalMoney(p.Amount)
		if err != nil {
			return nil, err
		}
		n.Participants = append(n.Participants, Participant{Nemtag: p.Nemtag, Amount: amt})
	}
	v, err := a.svc.CreateSplit(ctx, n)
	if err != nil {
		return nil, err
	}
	return api.CreateSplitBill201JSONResponse(SplitJSON(v)), nil
}

// GetSplitBill is GET /v1/split-bills/{split_bill_id}.
func (a *API) GetSplitBill(ctx context.Context, req api.GetSplitBillRequestObject) (api.GetSplitBillResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	v, err := a.svc.GetSplit(ctx, req.SplitBillId)
	if err != nil {
		return nil, err
	}
	return api.GetSplitBill200JSONResponse(SplitJSON(v)), nil
}

// RemindSplitBill is POST /v1/split-bills/{split_bill_id}/remind.
func (a *API) RemindSplitBill(ctx context.Context, req api.RemindSplitBillRequestObject) (api.RemindSplitBillResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	if err := a.svc.RemindSplit(ctx, req.SplitBillId); err != nil {
		return nil, err
	}
	return api.RemindSplitBill202Response{}, nil
}

// ListPaymentLinks is GET /v1/payment-links.
func (a *API) ListPaymentLinks(ctx context.Context, req api.ListPaymentLinksRequestObject) (api.ListPaymentLinksResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	rows, page, err := a.svc.ListLinks(ctx, req.Params.Cursor, req.Params.Limit)
	if err != nil {
		return nil, err
	}
	out := api.ListPaymentLinks200JSONResponse{Data: make([]api.PaymentLink, len(rows)), Page: page}
	for i, l := range rows {
		out.Data[i] = a.svc.LinkJSON(l)
	}
	return out, nil
}

// CreatePaymentLink is POST /v1/payment-links.
func (a *API) CreatePaymentLink(ctx context.Context, req api.CreatePaymentLinkRequestObject) (api.CreatePaymentLinkResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	b := req.Body
	amt, err := parseOptionalMoney(b.Amount)
	if err != nil {
		return nil, err
	}
	l, err := a.svc.CreateLink(ctx, NewLink{
		AccountID: b.AccountId, Title: b.Title, Note: b.Note, AmountMode: string(b.AmountMode), Amount: amt, ExpiresAt: b.ExpiresAt,
	})
	if err != nil {
		return nil, err
	}
	return api.CreatePaymentLink201JSONResponse(a.svc.LinkJSON(l)), nil
}

// GetPaymentLink is GET /v1/payment-links/{link_id}.
func (a *API) GetPaymentLink(ctx context.Context, req api.GetPaymentLinkRequestObject) (api.GetPaymentLinkResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	l, err := a.svc.GetLink(ctx, req.LinkId)
	if err != nil {
		return nil, err
	}
	return api.GetPaymentLink200JSONResponse(a.svc.LinkJSON(l)), nil
}

// UpdatePaymentLink is PATCH /v1/payment-links/{link_id}.
func (a *API) UpdatePaymentLink(ctx context.Context, req api.UpdatePaymentLinkRequestObject) (api.UpdatePaymentLinkResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	b := req.Body
	l, err := a.svc.UpdateLink(ctx, req.LinkId, b.Title, b.Note, (*string)(b.Status))
	if err != nil {
		return nil, err
	}
	return api.UpdatePaymentLink200JSONResponse(a.svc.LinkJSON(l)), nil
}

// GetPublicPaymentLink is GET /v1/public/payment-links/{slug} (no sign-in).
func (a *API) GetPublicPaymentLink(ctx context.Context, req api.GetPublicPaymentLinkRequestObject) (api.GetPublicPaymentLinkResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	l, err := a.svc.GetPublicLink(ctx, req.Slug)
	if err != nil {
		return nil, err
	}
	return api.GetPublicPaymentLink200JSONResponse(PublicLinkJSON(l)), nil
}

// PayPaymentLink is POST /v1/public/payment-links/{slug}/pay (signed in, signed, idempotent).
func (a *API) PayPaymentLink(ctx context.Context, req api.PayPaymentLinkRequestObject) (api.PayPaymentLinkResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	b := req.Body
	amt, err := parseOptionalMoney(b.Amount)
	if err != nil {
		return nil, err
	}
	note := ""
	if b.Note != nil {
		note = *b.Note
	}
	t, err := transferResponse(a.svc.PayLink(ctx, req.Slug, b.SourceAccountId, amt, note))
	if err != nil {
		return nil, err
	}
	return api.PayPaymentLink201JSONResponse(t), nil
}

// GetMyQr is GET /v1/qr/me.
func (a *API) GetMyQr(ctx context.Context, req api.GetMyQrRequestObject) (api.GetMyQrResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	var amt *money.Money
	if req.Params.AmountMinor != nil {
		m, err := money.ParseMinor(*req.Params.AmountMinor, string(money.NGN))
		if err != nil {
			return nil, fmt.Errorf("amount passed validation but not parsing: %w", err)
		}
		amt = &m
	}
	q, err := a.svc.MyQR(ctx, req.Params.AccountId, amt)
	if err != nil {
		return nil, err
	}
	out := api.GetMyQr200JSONResponse{Payload: q.Payload, AccountId: q.AccountID, ExpiresAt: q.ExpiresAt, KeyId: QRKeyID}
	if q.Amount != nil {
		m := accounts.Money(*q.Amount)
		out.Amount = &m
	}
	return out, nil
}

// DecodeQr is POST /v1/qr/decode.
func (a *API) DecodeQr(ctx context.Context, req api.DecodeQrRequestObject) (api.DecodeQrResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	d, err := a.svc.DecodeQR(ctx, req.Body.Payload)
	if err != nil {
		return nil, err
	}
	out := api.DecodeQr200JSONResponse{Valid: d.Valid, Payee: d.Payee}
	if d.Reason != "" {
		r := api.DecodedQrInvalidReason(d.Reason)
		out.InvalidReason = &r
	}
	if d.Amount != nil {
		m := accounts.Money(*d.Amount)
		out.Amount = &m
	}
	return out, nil
}
