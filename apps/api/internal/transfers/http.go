package transfers

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/admin"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers/partners"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers/transfersdb"
)

// API adapts the service to the contract's strict server; the router embeds it. A nil
// *API answers 501, so routers built without transfers (platform tests) still serve the
// contract's stub for these operations.
type API struct {
	svc *Service
}

// NewAPI returns the transfer operations for the router.
func NewAPI(svc *Service) *API { return &API{svc: svc} }

func timelineJSON(evs []transfersdb.TransferEvent) []api.TimelineEvent {
	out := make([]api.TimelineEvent, len(evs))
	for i, e := range evs {
		out[i] = api.TimelineEvent{Status: e.Status, Label: e.Label, At: e.At.UTC(), Detail: e.Detail}
	}
	return out
}

// TransferJSON is the contract's Transfer.
func TransferJSON(v View) (api.Transfer, error) {
	var party api.TransferParty
	if err := json.Unmarshal(v.Recipient, &party); err != nil {
		return api.Transfer{}, fmt.Errorf("recipient: %w", err)
	}
	c := money.Currency(v.Currency)
	total := v.AmountMinor + v.FeeMinor // both bounded by int64 balances; never near overflow
	out := api.Transfer{
		Id: v.ID, Reference: v.Reference, Status: api.TransferStatus(v.Status), Rail: api.TransferRail(v.Rail),
		SourceAccountId: v.SourceAccountID, Recipient: party,
		Amount: accounts.Money(money.New(v.AmountMinor, c)), Fee: accounts.Money(money.New(v.FeeMinor, c)),
		TotalDebit: accounts.Money(money.New(total, c)), Narration: v.Narration, StepUpId: v.StepUpID,
		ReleaseAt: v.ReleaseAt, Timeline: timelineJSON(v.Timeline), TransactionId: &v.TransactionID,
		CreatedAt: v.CreatedAt.UTC(), UpdatedAt: v.UpdatedAt.UTC(),
	}
	if v.Risk != nil {
		var r api.RiskAssessment
		if err := json.Unmarshal(v.Risk, &r); err != nil {
			return api.Transfer{}, fmt.Errorf("risk: %w", err)
		}
		out.Risk = &r
	}
	if v.Reversal != nil {
		var r api.Reversal
		if err := json.Unmarshal(v.Reversal, &r); err != nil {
			return api.Transfer{}, fmt.Errorf("reversal: %w", err)
		}
		out.Reversal = &r
	}
	return out, nil
}

// CreateTransfer is POST /v1/transfers (device-signed and idempotent at the edge).
func (a *API) CreateTransfer(ctx context.Context, req api.CreateTransferRequestObject) (api.CreateTransferResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	b := req.Body
	amount, err := money.ParseMinor(b.Amount.AmountMinor, string(b.Amount.Currency))
	if err != nil {
		return nil, fmt.Errorf("amount passed validation but not parsing: %w", err)
	}
	r := Request{SourceAccountID: b.SourceAccountId, Destination: b.Destination, Amount: amount}
	if b.Narration != nil {
		r.Narration = *b.Narration
	}
	if b.Category != nil {
		c := string(*b.Category)
		r.Category = &c
	}
	v, err := a.svc.Create(ctx, r)
	if err != nil {
		return nil, err
	}
	t, err := TransferJSON(v)
	if err != nil {
		return nil, err
	}
	return api.CreateTransfer201JSONResponse(t), nil
}

// GetTransfer is GET /v1/transfers/{transfer_id}.
func (a *API) GetTransfer(ctx context.Context, req api.GetTransferRequestObject) (api.GetTransferResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	v, err := a.svc.Get(ctx, req.TransferId)
	if err != nil {
		return nil, err
	}
	t, err := TransferJSON(v)
	if err != nil {
		return nil, err
	}
	return api.GetTransfer200JSONResponse(t), nil
}

// ListTransfers is GET /v1/transfers.
func (a *API) ListTransfers(ctx context.Context, req api.ListTransfersRequestObject) (api.ListTransfersResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	p := req.Params
	views, page, err := a.svc.List(ctx, (*string)(p.Status), p.Cursor, p.Limit)
	if err != nil {
		return nil, err
	}
	out := api.ListTransfers200JSONResponse{Data: make([]api.Transfer, 0, len(views)), Page: page}
	for _, v := range views {
		t, err := TransferJSON(v)
		if err != nil {
			return nil, err
		}
		out.Data = append(out.Data, t)
	}
	return out, nil
}

// ListBanks is GET /v1/banks.
func (a *API) ListBanks(context.Context, api.ListBanksRequestObject) (api.ListBanksResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	return api.ListBanks200JSONResponse{Data: Banks()}, nil
}

// ResolvePayee is POST /v1/payees/resolve: name enquiry and Confirmation of Payee.
func (a *API) ResolvePayee(ctx context.Context, req api.ResolvePayeeRequestObject) (api.ResolvePayeeResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	p, err := a.svc.ResolvePayee(ctx, *req.Body)
	if err != nil {
		return nil, err
	}
	return api.ResolvePayee200JSONResponse(p), nil
}

func simulatorJSON(s partners.Settings) api.BankPartnerSimulator {
	timeout := s.TimeoutRateBps
	return api.BankPartnerSimulator{
		FailureRateBps: s.FailureRateBps, MinDelaySeconds: s.MinDelaySeconds, MaxDelaySeconds: s.MaxDelaySeconds,
		NameCheck: api.BankPartnerSimulatorNameCheck(s.NameCheck), TimeoutRateBps: &timeout,
	}
}

// GetBankPartnerSimulator is GET /v1/admin/simulators/bank-partner (admin; x-roles checked
// by the validator).
func (a *API) GetBankPartnerSimulator(ctx context.Context, _ api.GetBankPartnerSimulatorRequestObject) (api.GetBankPartnerSimulatorResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	s, err := a.svc.sandbox.Settings(ctx)
	if err != nil {
		return nil, err
	}
	return api.GetBankPartnerSimulator200JSONResponse(simulatorJSON(s)), nil
}

// SetBankPartnerSimulator is PUT /v1/admin/simulators/bank-partner, audited.
func (a *API) SetBankPartnerSimulator(ctx context.Context, req api.SetBankPartnerSimulatorRequestObject) (api.SetBankPartnerSimulatorResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	staff, ok := admin.PrincipalFrom(ctx)
	if !ok {
		return nil, problem.Unauthorized()
	}
	b := req.Body
	in := partners.Settings{
		FailureRateBps: b.FailureRateBps, MinDelaySeconds: b.MinDelaySeconds, MaxDelaySeconds: b.MaxDelaySeconds,
		NameCheck: partners.NameCheck(b.NameCheck),
	}
	if b.TimeoutRateBps != nil {
		in.TimeoutRateBps = *b.TimeoutRateBps
	}
	s, err := a.svc.sandbox.SetSettings(ctx, staff.StaffID, staff.Name, in)
	if err != nil {
		return nil, err
	}
	return api.SetBankPartnerSimulator200JSONResponse(simulatorJSON(s)), nil
}
