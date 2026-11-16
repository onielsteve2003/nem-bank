package insights

import (
	"context"
	"strconv"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// API adapts the service to the contract's strict server; the router embeds it. A nil *API
// answers 501.
type API struct{ svc *Service }

// NewAPI returns the insights operations for the router.
func NewAPI(svc *Service) *API { return &API{svc: svc} }

func apiMoney(minor int64, currency string) api.Money {
	return api.Money{AmountMinor: strconv.FormatInt(minor, 10), Currency: api.CurrencyCode(currency)}
}

func budgetJSON(b Budget) api.Budget {
	return api.Budget{
		Id: b.ID, Category: api.Category(b.Category), Limit: apiMoney(b.Limit, "NGN"), Spent: apiMoney(b.Spent, "NGN"),
		Status: api.BudgetStatus(b.Status()), AlertAtPct: []api.BudgetAlertAtPct{80, 100},
	}
}

func minorOf(m api.Money) (int64, error) {
	n, err := strconv.ParseInt(m.AmountMinor, 10, 64)
	if err != nil {
		return 0, problem.Validation(problem.Field("/limit/amount_minor", "bad_format", "Enter a whole amount in kobo"))
	}
	return n, nil
}

// GetSpending is GET /v1/insights/spending.
func (a *API) GetSpending(ctx context.Context, req api.GetSpendingRequestObject) (api.GetSpendingResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	var month, currency string
	if req.Params.Month != nil {
		month = *req.Params.Month
	}
	if req.Params.Currency != nil {
		currency = string(*req.Params.Currency)
	}
	b, err := a.svc.Spending(ctx, month, currency)
	if err != nil {
		return nil, err
	}
	out := api.SpendingBreakdown{
		Month: b.Month.String(), Total: apiMoney(b.Total, b.Currency), PreviousTotal: apiMoney(b.PreviousTotal, b.Currency),
		Categories: make([]api.CategorySpend, len(b.Categories)),
	}
	for i, c := range b.Categories {
		out.Categories[i] = api.CategorySpend{
			Category: api.Category(c.Category), Amount: apiMoney(c.Amount, b.Currency),
			SharePct: c.Share, PreviousAmount: apiMoney(c.Previous, b.Currency),
		}
	}
	return api.GetSpending200JSONResponse(out), nil
}

// ListBudgets is GET /v1/insights/budgets.
func (a *API) ListBudgets(ctx context.Context, _ api.ListBudgetsRequestObject) (api.ListBudgetsResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	list, err := a.svc.ListBudgets(ctx)
	if err != nil {
		return nil, err
	}
	out := api.BudgetList{Data: make([]api.Budget, len(list))}
	for i, b := range list {
		out.Data[i] = budgetJSON(b)
	}
	return api.ListBudgets200JSONResponse(out), nil
}

// CreateBudget is POST /v1/insights/budgets.
func (a *API) CreateBudget(ctx context.Context, req api.CreateBudgetRequestObject) (api.CreateBudgetResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	minor, err := minorOf(req.Body.Limit)
	if err != nil {
		return nil, err
	}
	b, err := a.svc.CreateBudget(ctx, string(req.Body.Category), string(req.Body.Limit.Currency), minor)
	if err != nil {
		return nil, err
	}
	return api.CreateBudget201JSONResponse(budgetJSON(b)), nil
}

// UpdateBudget is PATCH /v1/insights/budgets/{budget_id}.
func (a *API) UpdateBudget(ctx context.Context, req api.UpdateBudgetRequestObject) (api.UpdateBudgetResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	minor, err := minorOf(req.Body.Limit)
	if err != nil {
		return nil, err
	}
	b, err := a.svc.UpdateBudget(ctx, uuid.UUID(req.BudgetId), string(req.Body.Limit.Currency), minor)
	if err != nil {
		return nil, err
	}
	return api.UpdateBudget200JSONResponse(budgetJSON(b)), nil
}

// DeleteBudget is DELETE /v1/insights/budgets/{budget_id}.
func (a *API) DeleteBudget(ctx context.Context, req api.DeleteBudgetRequestObject) (api.DeleteBudgetResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	if err := a.svc.DeleteBudget(ctx, uuid.UUID(req.BudgetId)); err != nil {
		return nil, err
	}
	return api.DeleteBudget204Response{}, nil
}

// GetMoneyStory is GET /v1/insights/money-story.
func (a *API) GetMoneyStory(ctx context.Context, req api.GetMoneyStoryRequestObject) (api.GetMoneyStoryResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	var month string
	if req.Params.Month != nil {
		month = *req.Params.Month
	}
	st, err := a.svc.MoneyStory(ctx, month)
	if err != nil {
		return nil, err
	}
	out := api.MoneyStory{Month: st.Month.String(), Slides: make([]api.StorySlide, len(st.Slides))}
	for i, sl := range st.Slides {
		o := api.StorySlide{Kind: api.StorySlideKind(sl.Kind), Title: sl.Title, Body: sl.Body}
		if sl.Amount != nil {
			m := apiMoney(*sl.Amount, "NGN")
			o.Amount = &m
		}
		if sl.Category != "" {
			c := api.Category(sl.Category)
			o.Category = &c
		}
		out.Slides[i] = o
	}
	return api.GetMoneyStory200JSONResponse(out), nil
}
