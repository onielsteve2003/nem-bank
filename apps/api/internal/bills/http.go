package bills

import (
	"context"

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

// NewAPI returns the bill operations for the router.
func NewAPI(svc *Service) *API { return &API{svc: svc} }

func billerJSON(b Info) api.Biller {
	out := api.Biller{
		Id: b.ID, Category: api.BillCategory(b.Category), Name: b.Name,
		RequiresValidation: b.RequiresValidation, HasProducts: b.HasProducts,
	}
	if b.Network != "" {
		n := api.MobileNetwork(b.Network)
		out.Network = &n
	}
	if b.MinAmount.IsPositive() {
		m := accounts.Money(b.MinAmount)
		out.MinAmount = &m
	}
	return out
}

// ListBillers is GET /v1/billers.
func (a *API) ListBillers(ctx context.Context, req api.ListBillersRequestObject) (api.ListBillersResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	category := ""
	if req.Params.Category != nil {
		category = string(*req.Params.Category)
	}
	list, err := a.svc.Billers(ctx, category)
	if err != nil {
		return nil, err
	}
	out := api.ListBillers200JSONResponse{Data: make([]api.Biller, len(list))}
	for i, b := range list {
		out.Data[i] = billerJSON(b)
	}
	return out, nil
}

// ListBillerProducts is GET /v1/billers/{biller_id}/products.
func (a *API) ListBillerProducts(ctx context.Context, req api.ListBillerProductsRequestObject) (api.ListBillerProductsResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	list, err := a.svc.Products(ctx, req.BillerId)
	if err != nil {
		return nil, err
	}
	out := api.ListBillerProducts200JSONResponse{Data: make([]api.BillerProduct, len(list))}
	for i, p := range list {
		out.Data[i] = api.BillerProduct{Id: p.ID, Name: p.Name, Amount: accounts.Money(p.Amount)}
		if p.ValidityDays > 0 {
			d := p.ValidityDays
			out.Data[i].ValidityDays = &d
		}
	}
	return out, nil
}

// DetectNetwork is POST /v1/bills/detect-network.
func (a *API) DetectNetwork(_ context.Context, req api.DetectNetworkRequestObject) (api.DetectNetworkResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	out := api.DetectNetwork200JSONResponse{Phone: req.Body.Phone}
	if n := DetectNetwork(req.Body.Phone); n != "" {
		m := api.MobileNetwork(n)
		out.Network = &m
	}
	return out, nil
}

// ValidateBillCustomer is POST /v1/bills/validate.
func (a *API) ValidateBillCustomer(ctx context.Context, req api.ValidateBillCustomerRequestObject) (api.ValidateBillCustomerResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	c, err := a.svc.Validate(ctx, req.Body.BillerId, req.Body.CustomerId)
	if err != nil {
		return nil, err
	}
	out := api.ValidateBillCustomer200JSONResponse{BillerId: req.Body.BillerId, CustomerId: c.ID, CustomerName: c.Name}
	if c.Address != "" {
		out.Address = &c.Address
	}
	if c.CurrentPlan != "" {
		out.CurrentPlan = &c.CurrentPlan
	}
	return out, nil
}

// PaymentJSON is the contract's BillPayment.
func PaymentJSON(p Payment) api.BillPayment {
	return api.BillPayment{
		Id: p.ID, Reference: p.Reference, BillerId: p.BillerID, BillerName: p.BillerName, Category: api.BillCategory(p.Category),
		ProductName: p.ProductName, CustomerId: p.CustomerID, Amount: accounts.Money(p.Amount), Fee: accounts.Money(p.Fee),
		Status: api.BillPaymentStatus(p.Status), Token: p.Token, Units: p.Units, TransactionId: p.TransactionID, CreatedAt: p.CreatedAt,
	}
}

// PayBill is POST /v1/bills/payments.
func (a *API) PayBill(ctx context.Context, req api.PayBillRequestObject) (api.PayBillResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	b := req.Body
	amount, err := money.ParseMinor(b.Amount.AmountMinor, string(b.Amount.Currency))
	if err != nil {
		return nil, problem.Validation(problem.Field("/amount", "invalid", "Enter a valid amount."))
	}
	pr := PayRequest{BillerID: b.BillerId, CustomerID: b.CustomerId, Amount: amount, Source: b.SourceAccountId}
	if b.ProductId != nil {
		pr.ProductID = *b.ProductId
	}
	p, err := a.svc.Pay(ctx, pr)
	if err != nil {
		return nil, err
	}
	return api.PayBill201JSONResponse(PaymentJSON(p)), nil
}

// ListBillPayments is GET /v1/bills/payments.
func (a *API) ListBillPayments(ctx context.Context, req api.ListBillPaymentsRequestObject) (api.ListBillPaymentsResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	rows, page, err := a.svc.List(ctx, req.Params.Cursor, req.Params.Limit)
	if err != nil {
		return nil, err
	}
	out := api.ListBillPayments200JSONResponse{Data: make([]api.BillPayment, len(rows)), Page: page}
	for i, p := range rows {
		out.Data[i] = PaymentJSON(p)
	}
	return out, nil
}

// GetBillPayment is GET /v1/bills/payments/{payment_id}.
func (a *API) GetBillPayment(ctx context.Context, req api.GetBillPaymentRequestObject) (api.GetBillPaymentResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	p, err := a.svc.Get(ctx, req.PaymentId)
	if err != nil {
		return nil, err
	}
	return api.GetBillPayment200JSONResponse(PaymentJSON(p)), nil
}
