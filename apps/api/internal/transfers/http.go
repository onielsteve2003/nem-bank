package transfers

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/admin"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/limits"
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
	if b.SaveBeneficiary != nil {
		r.SaveBeneficiary = *b.SaveBeneficiary
	}
	if req.Params.XStepUpToken != nil {
		r.StepUpToken = *req.Params.XStepUpToken
	}
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

// QuoteTransfer is POST /v1/transfers/quote.
func (a *API) QuoteTransfer(ctx context.Context, req api.QuoteTransferRequestObject) (api.QuoteTransferResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	b := req.Body
	amount, err := money.ParseMinor(b.Amount.AmountMinor, string(b.Amount.Currency))
	if err != nil {
		return nil, fmt.Errorf("amount passed validation but not parsing: %w", err)
	}
	q, err := a.svc.Quote(ctx, Request{SourceAccountID: b.SourceAccountId, Destination: b.Destination, Amount: amount})
	if err != nil {
		return nil, err
	}
	out := api.QuoteTransfer200JSONResponse{
		QuoteId: q.ID, Amount: accounts.Money(q.Amount), Fee: accounts.Money(q.Fee), Fees: make([]api.FeeLine, len(q.Fees)),
		TotalDebit: accounts.Money(q.Total), Limits: limits.StatusJSON(q.Limits), Rail: api.TransferRail(q.Rail),
		ExpiresAt: q.Expires.UTC(),
	}
	for i, f := range q.Fees {
		out.Fees[i] = api.FeeLine{Code: api.FeeLineCode(f.Code), Label: f.Label, Amount: accounts.Money(f.Amount)}
	}
	out.CoolingOff = q.CoolingOff
	return out, nil
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

// ReceivePartnerWebhook is POST /v1/partner-webhooks/{partner}. The request validator has
// already checked Partner-Signature over the raw body (VerifyPartnerCallback), so the body
// is the partner's. A repeat of a handled event is answered 200 like the first, so the
// partner stops retrying.
func (a *API) ReceivePartnerWebhook(ctx context.Context, req api.ReceivePartnerWebhookRequestObject) (api.ReceivePartnerWebhookResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	if _, err := a.svc.HandlePartnerCallback(ctx, string(req.Partner), req.Params.PartnerEventId, *req.Body); err != nil {
		return nil, err
	}
	return api.ReceivePartnerWebhook200Response{}, nil
}

func transferResponse(v View, err error) (api.Transfer, error) {
	if err != nil {
		return api.Transfer{}, err
	}
	return TransferJSON(v)
}

// StepUpTransfer is POST /v1/transfers/{transfer_id}/step-up (signed, idempotent).
func (a *API) StepUpTransfer(ctx context.Context, req api.StepUpTransferRequestObject) (api.StepUpTransferResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	t, err := transferResponse(a.svc.StepUp(ctx, req.TransferId, req.Params.XStepUpToken))
	if err != nil {
		return nil, err
	}
	return api.StepUpTransfer200JSONResponse(t), nil
}

// CancelTransfer is POST /v1/transfers/{transfer_id}/cancel.
func (a *API) CancelTransfer(ctx context.Context, req api.CancelTransferRequestObject) (api.CancelTransferResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	t, err := transferResponse(a.svc.Cancel(ctx, req.TransferId))
	if err != nil {
		return nil, err
	}
	return api.CancelTransfer200JSONResponse(t), nil
}

// ListBeneficiaries is GET /v1/beneficiaries.
func (a *API) ListBeneficiaries(ctx context.Context, req api.ListBeneficiariesRequestObject) (api.ListBeneficiariesResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	p := req.Params
	rows, page, err := a.svc.ListBeneficiaries(ctx, p.Favourite, p.Q, p.Cursor, p.Limit)
	if err != nil {
		return nil, err
	}
	out := api.ListBeneficiaries200JSONResponse{Data: make([]api.Beneficiary, len(rows)), Page: page}
	for i, b := range rows {
		out.Data[i] = BeneficiaryJSON(b)
	}
	return out, nil
}

// CreateBeneficiary is POST /v1/beneficiaries.
func (a *API) CreateBeneficiary(ctx context.Context, req api.CreateBeneficiaryRequestObject) (api.CreateBeneficiaryResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	b := req.Body
	fav := b.Favourite != nil && *b.Favourite
	saved, err := a.svc.CreateBeneficiary(ctx, b.Destination, b.Nickname, fav)
	if err != nil {
		return nil, err
	}
	return api.CreateBeneficiary201JSONResponse(BeneficiaryJSON(saved)), nil
}

// UpdateBeneficiary is PATCH /v1/beneficiaries/{beneficiary_id}.
func (a *API) UpdateBeneficiary(ctx context.Context, req api.UpdateBeneficiaryRequestObject) (api.UpdateBeneficiaryResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	b, err := a.svc.UpdateBeneficiary(ctx, req.BeneficiaryId, req.Body.Nickname, req.Body.Favourite)
	if err != nil {
		return nil, err
	}
	return api.UpdateBeneficiary200JSONResponse(BeneficiaryJSON(b)), nil
}

// DeleteBeneficiary is DELETE /v1/beneficiaries/{beneficiary_id}.
func (a *API) DeleteBeneficiary(ctx context.Context, req api.DeleteBeneficiaryRequestObject) (api.DeleteBeneficiaryResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	if err := a.svc.DeleteBeneficiary(ctx, req.BeneficiaryId); err != nil {
		return nil, err
	}
	return api.DeleteBeneficiary204Response{}, nil
}

// ListScheduledTransfers is GET /v1/scheduled-transfers.
func (a *API) ListScheduledTransfers(ctx context.Context, req api.ListScheduledTransfersRequestObject) (api.ListScheduledTransfersResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	rows, page, err := a.svc.ListSchedules(ctx, req.Params.Cursor, req.Params.Limit)
	if err != nil {
		return nil, err
	}
	out := api.ListScheduledTransfers200JSONResponse{Data: make([]api.ScheduledTransfer, len(rows)), Page: page}
	for i, sch := range rows {
		if out.Data[i], err = ScheduleJSON(sch); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// CreateScheduledTransfer is POST /v1/scheduled-transfers (signed, idempotent).
func (a *API) CreateScheduledTransfer(ctx context.Context, req api.CreateScheduledTransferRequestObject) (api.CreateScheduledTransferResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	b := req.Body
	amount, err := money.ParseMinor(b.Amount.AmountMinor, string(b.Amount.Currency))
	if err != nil {
		return nil, fmt.Errorf("amount passed validation but not parsing: %w", err)
	}
	n := NewSchedule{SourceAccountID: b.SourceAccountId, Destination: b.Destination, Amount: amount, Frequency: string(b.Frequency), StartAt: b.StartAt}
	if b.Narration != nil {
		n.Narration = *b.Narration
	}
	if b.EndsOn != nil {
		n.EndsOn = &b.EndsOn.Time
	}
	sch, err := a.svc.CreateSchedule(ctx, n)
	if err != nil {
		return nil, err
	}
	out, err := ScheduleJSON(sch)
	if err != nil {
		return nil, err
	}
	return api.CreateScheduledTransfer201JSONResponse(out), nil
}

// GetScheduledTransfer is GET /v1/scheduled-transfers/{schedule_id}.
func (a *API) GetScheduledTransfer(ctx context.Context, req api.GetScheduledTransferRequestObject) (api.GetScheduledTransferResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	sch, err := a.svc.GetSchedule(ctx, req.ScheduleId)
	if err != nil {
		return nil, err
	}
	out, err := ScheduleJSON(sch)
	if err != nil {
		return nil, err
	}
	return api.GetScheduledTransfer200JSONResponse(out), nil
}

// UpdateScheduledTransfer is PATCH /v1/scheduled-transfers/{schedule_id} (signed).
func (a *API) UpdateScheduledTransfer(ctx context.Context, req api.UpdateScheduledTransferRequestObject) (api.UpdateScheduledTransferResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	b := req.Body
	c := ScheduleChange{NextRunAt: b.NextRunAt}
	if b.Status != nil {
		st := string(*b.Status)
		c.Status = &st
	}
	if b.Amount != nil {
		m, err := money.ParseMinor(b.Amount.AmountMinor, string(b.Amount.Currency))
		if err != nil {
			return nil, fmt.Errorf("amount passed validation but not parsing: %w", err)
		}
		c.Amount = &m
	}
	sch, err := a.svc.UpdateSchedule(ctx, req.ScheduleId, c)
	if err != nil {
		return nil, err
	}
	out, err := ScheduleJSON(sch)
	if err != nil {
		return nil, err
	}
	return api.UpdateScheduledTransfer200JSONResponse(out), nil
}

// CancelScheduledTransfer is DELETE /v1/scheduled-transfers/{schedule_id}.
func (a *API) CancelScheduledTransfer(ctx context.Context, req api.CancelScheduledTransferRequestObject) (api.CancelScheduledTransferResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	if err := a.svc.CancelSchedule(ctx, req.ScheduleId); err != nil {
		return nil, err
	}
	return api.CancelScheduledTransfer204Response{}, nil
}
