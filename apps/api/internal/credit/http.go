package credit

import (
	"context"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// API adapts the service to the contract's strict server; the router embeds it. A nil *API
// answers 501.
type API struct {
	svc *Service
}

// NewAPI returns the credit operations for the router.
func NewAPI(svc *Service) *API { return &API{svc: svc} }

func parseMoney(m api.Money, field string) (money.Money, error) {
	out, err := money.ParseMinor(m.AmountMinor, string(m.Currency))
	if err != nil {
		return money.Money{}, problem.Validation(problem.Field(field, "invalid", "Enter a valid amount."))
	}
	return out, nil
}

func installmentJSON(i Installment) api.Installment {
	return api.Installment{
		Number: i.Number, DueDate: openapi_types.Date{Time: i.Due}, Amount: accounts.Money(i.Amount),
		Paid: accounts.Money(i.Paid), Status: api.InstallmentStatus(i.Status),
	}
}

func scheduleJSON(items []Installment) []api.Installment {
	out := make([]api.Installment, len(items))
	for i, it := range items {
		out[i] = installmentJSON(it)
	}
	return out
}

// LoanJSON is the contract's Loan.
func LoanJSON(l Loan) api.Loan {
	out := api.Loan{
		Id: l.ID, Principal: accounts.Money(l.Principal), Outstanding: accounts.Money(l.Outstanding), AprBps: l.AprBps,
		TenorDays: l.TenorDays, Status: api.LoanStatus(l.Status), AutoRepay: l.AutoRepay, Schedule: scheduleJSON(l.Schedule),
		DisbursedAt: l.DisbursedAt,
	}
	if l.NextDue != nil {
		n := installmentJSON(*l.NextDue)
		out.NextDue = &n
	}
	if l.Payoff != nil {
		p := accounts.Money(*l.Payoff)
		out.PayoffAmount = &p
	}
	return out
}

// GetCreditEligibility is GET /v1/credit/eligibility.
func (a *API) GetCreditEligibility(ctx context.Context, _ api.GetCreditEligibilityRequestObject) (api.GetCreditEligibilityResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	e, err := a.svc.Eligibility(ctx)
	if err != nil {
		return nil, err
	}
	reasons := make([]api.ReasonCode, len(e.Reasons))
	for i, r := range e.Reasons {
		reasons[i] = api.ReasonCode{Code: r.Code, Impact: api.ReasonCodeImpact(r.Impact), Message: r.Message}
	}
	return api.GetCreditEligibility200JSONResponse{
		Eligible: e.Eligible, MaxAmount: accounts.Money(e.Max), ScoreBand: api.CreditEligibilityScoreBand(e.Band), Reasons: reasons,
		Ai: api.AiMeta{
			Feature: api.AiMetaFeatureCreditScoring, ModelVersion: e.AI.ModelVersion, Explanation: e.AI.Explanation, FallbackUsed: e.AI.FallbackUsed,
		},
		CheckedAt: e.At,
	}, nil
}

// CreateLoanOffer is POST /v1/credit/offers.
func (a *API) CreateLoanOffer(ctx context.Context, req api.CreateLoanOfferRequestObject) (api.CreateLoanOfferResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	amount, err := parseMoney(req.Body.Amount, "/amount")
	if err != nil {
		return nil, err
	}
	o, err := a.svc.CreateOffer(ctx, amount, int(req.Body.TenorDays))
	if err != nil {
		return nil, err
	}
	return api.CreateLoanOffer201JSONResponse{
		OfferId: o.ID, Principal: accounts.Money(o.Terms.Principal), TenorDays: o.Terms.TenorDays, AprBps: o.Terms.AprBps,
		Interest: accounts.Money(o.Terms.Interest), Fees: accounts.Money(o.Terms.Fee), TotalRepayment: accounts.Money(o.Terms.Total),
		Schedule: scheduleJSON(o.Schedule), ExpiresAt: o.ExpiresAt,
	}, nil
}

// ListLoans is GET /v1/credit/loans.
func (a *API) ListLoans(ctx context.Context, _ api.ListLoansRequestObject) (api.ListLoansResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	loans, err := a.svc.Loans(ctx)
	if err != nil {
		return nil, err
	}
	out := api.ListLoans200JSONResponse{Data: make([]api.Loan, len(loans))}
	for i, l := range loans {
		out.Data[i] = LoanJSON(l)
	}
	return out, nil
}

// AcceptLoanOffer is POST /v1/credit/loans.
func (a *API) AcceptLoanOffer(ctx context.Context, req api.AcceptLoanOfferRequestObject) (api.AcceptLoanOfferResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	l, err := a.svc.Accept(ctx, req.Body.OfferId, req.Body.DisbursementAccountId, req.Body.AutoRepay)
	if err != nil {
		return nil, err
	}
	return api.AcceptLoanOffer201JSONResponse(LoanJSON(l)), nil
}

// GetLoan is GET /v1/credit/loans/{loan_id}.
func (a *API) GetLoan(ctx context.Context, req api.GetLoanRequestObject) (api.GetLoanResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	l, err := a.svc.Loan(ctx, req.LoanId)
	if err != nil {
		return nil, err
	}
	return api.GetLoan200JSONResponse(LoanJSON(l)), nil
}

// UpdateLoan is PATCH /v1/credit/loans/{loan_id}.
func (a *API) UpdateLoan(ctx context.Context, req api.UpdateLoanRequestObject) (api.UpdateLoanResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	l, err := a.svc.SetAutoRepay(ctx, req.LoanId, req.Body.AutoRepay)
	if err != nil {
		return nil, err
	}
	return api.UpdateLoan200JSONResponse(LoanJSON(l)), nil
}

// RepayLoan is POST /v1/credit/loans/{loan_id}/repayments.
func (a *API) RepayLoan(ctx context.Context, req api.RepayLoanRequestObject) (api.RepayLoanResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	amount, err := parseMoney(req.Body.Amount, "/amount")
	if err != nil {
		return nil, err
	}
	l, err := a.svc.Repay(ctx, req.LoanId, req.Body.AccountId, amount)
	if err != nil {
		return nil, err
	}
	return api.RepayLoan201JSONResponse(LoanJSON(l)), nil
}
