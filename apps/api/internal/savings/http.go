package savings

import (
	"context"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
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

// NewAPI returns the savings operations for the router.
func NewAPI(svc *Service) *API { return &API{svc: svc} }

func parseMoney(m api.Money, field string) (money.Money, error) {
	out, err := money.ParseMinor(m.AmountMinor, string(m.Currency))
	if err != nil {
		return money.Money{}, problem.Validation(problem.Field(field, "invalid", "Enter a valid amount."))
	}
	return out, nil
}

func dateOf(d *api.Date) *time.Time {
	if d == nil {
		return nil
	}
	t := time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, time.UTC)
	return &t
}

func ruleOf(r *api.AutoSaveRule) (*AutoSave, error) {
	if r == nil {
		return nil, nil
	}
	amount, err := parseMoney(r.Amount, "/auto_save/amount")
	if err != nil {
		return nil, err
	}
	return &AutoSave{Amount: amount, Frequency: string(r.Frequency), Source: r.SourceAccountId}, nil
}

// GoalJSON is the contract's SavingsGoal.
func GoalJSON(g Goal) api.SavingsGoal {
	out := api.SavingsGoal{
		Id: g.ID, Name: g.Name, Emoji: g.Emoji, Target: accounts.Money(g.Target), Balance: accounts.Money(g.Balance),
		ProgressPct: g.ProgressPct, InterestRateBps: g.InterestRate, InterestEarned: accounts.Money(g.InterestEarned),
		Status: api.SavingsGoalStatus(g.Status), CreatedAt: g.CreatedAt,
	}
	if g.TargetDate != nil {
		out.TargetDate = &openapi_types.Date{Time: *g.TargetDate}
	}
	if g.AutoSave != nil {
		out.AutoSave = &api.AutoSaveRule{
			Amount: accounts.Money(g.AutoSave.Amount), Frequency: api.AutoSaveRuleFrequency(g.AutoSave.Frequency), SourceAccountId: g.AutoSave.Source,
		}
	}
	return out
}

// GetSavingsSummary is GET /v1/savings/summary.
func (a *API) GetSavingsSummary(ctx context.Context, _ api.GetSavingsSummaryRequestObject) (api.GetSavingsSummaryResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	sum, err := a.svc.Summary(ctx)
	if err != nil {
		return nil, err
	}
	return api.GetSavingsSummary200JSONResponse{
		TotalSaved: accounts.Money(sum.TotalSaved), InterestEarned: accounts.Money(sum.InterestEarned),
		GoalsCount: sum.Goals, LocksCount: sum.Locks, RoundUpsThisMonth: accounts.Money(sum.RoundUpsThisMonth),
	}, nil
}

// ListSavingsGoals is GET /v1/savings/goals.
func (a *API) ListSavingsGoals(ctx context.Context, _ api.ListSavingsGoalsRequestObject) (api.ListSavingsGoalsResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	list, err := a.svc.List(ctx)
	if err != nil {
		return nil, err
	}
	out := api.ListSavingsGoals200JSONResponse{Data: make([]api.SavingsGoal, len(list))}
	for i, g := range list {
		out.Data[i] = GoalJSON(g)
	}
	return out, nil
}

// CreateSavingsGoal is POST /v1/savings/goals.
func (a *API) CreateSavingsGoal(ctx context.Context, req api.CreateSavingsGoalRequestObject) (api.CreateSavingsGoalResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	b := req.Body
	target, err := parseMoney(b.Target, "/target")
	if err != nil {
		return nil, err
	}
	rule, err := ruleOf(b.AutoSave)
	if err != nil {
		return nil, err
	}
	g, err := a.svc.Create(ctx, GoalInput{Name: b.Name, Emoji: b.Emoji, Target: target, TargetDate: dateOf(b.TargetDate), AutoSave: rule})
	if err != nil {
		return nil, err
	}
	return api.CreateSavingsGoal201JSONResponse(GoalJSON(g)), nil
}

// GetSavingsGoal is GET /v1/savings/goals/{goal_id}.
func (a *API) GetSavingsGoal(ctx context.Context, req api.GetSavingsGoalRequestObject) (api.GetSavingsGoalResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	g, err := a.svc.Get(ctx, req.GoalId)
	if err != nil {
		return nil, err
	}
	return api.GetSavingsGoal200JSONResponse(GoalJSON(g)), nil
}

// explicitNull reports whether the request body named key with a JSON null. The generated
// type folds "null" and "absent" together, but for target_date and auto_save they mean
// different things (clear it / leave it), so the validated body is asked directly.
func explicitNull(ctx context.Context, key string) bool {
	gc, ok := ctx.(*gin.Context)
	if !ok || gc.Request == nil {
		return false
	}
	vb, ok := gc.Request.Body.(interface{ ValidatedValue() any })
	if !ok {
		return false
	}
	m, ok := vb.ValidatedValue().(map[string]any)
	if !ok {
		return false
	}
	v, present := m[key]
	return present && v == nil
}

// UpdateSavingsGoal is PATCH /v1/savings/goals/{goal_id}.
func (a *API) UpdateSavingsGoal(ctx context.Context, req api.UpdateSavingsGoalRequestObject) (api.UpdateSavingsGoalResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	b := req.Body
	e := Edit{
		Name: b.Name, Emoji: b.Emoji, TargetDate: dateOf(b.TargetDate),
		ClearTargetDate: b.TargetDate == nil && explicitNull(ctx, "target_date"),
		ClearAutoSave:   b.AutoSave == nil && explicitNull(ctx, "auto_save"),
	}
	if b.Target != nil {
		t, err := parseMoney(*b.Target, "/target")
		if err != nil {
			return nil, err
		}
		e.Target = &t
	}
	rule, err := ruleOf(b.AutoSave)
	if err != nil {
		return nil, err
	}
	e.AutoSave = rule
	g, err := a.svc.Update(ctx, req.GoalId, e)
	if err != nil {
		return nil, err
	}
	return api.UpdateSavingsGoal200JSONResponse(GoalJSON(g)), nil
}

// CloseSavingsGoal is DELETE /v1/savings/goals/{goal_id}.
func (a *API) CloseSavingsGoal(ctx context.Context, req api.CloseSavingsGoalRequestObject) (api.CloseSavingsGoalResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	if err := a.svc.Close(ctx, req.GoalId); err != nil {
		return nil, err
	}
	return api.CloseSavingsGoal204Response{}, nil
}

// DepositToGoal is POST /v1/savings/goals/{goal_id}/deposits.
func (a *API) DepositToGoal(ctx context.Context, req api.DepositToGoalRequestObject) (api.DepositToGoalResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	amount, err := parseMoney(req.Body.Amount, "/amount")
	if err != nil {
		return nil, err
	}
	g, err := a.svc.Deposit(ctx, req.GoalId, req.Body.AccountId, amount)
	if err != nil {
		return nil, err
	}
	return api.DepositToGoal201JSONResponse(GoalJSON(g)), nil
}

// WithdrawFromGoal is POST /v1/savings/goals/{goal_id}/withdrawals.
func (a *API) WithdrawFromGoal(ctx context.Context, req api.WithdrawFromGoalRequestObject) (api.WithdrawFromGoalResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	amount, err := parseMoney(req.Body.Amount, "/amount")
	if err != nil {
		return nil, err
	}
	g, err := a.svc.Withdraw(ctx, req.GoalId, req.Body.AccountId, amount)
	if err != nil {
		return nil, err
	}
	return api.WithdrawFromGoal201JSONResponse(GoalJSON(g)), nil
}

func roundUpsJSON(r RoundUpSettings) api.RoundUpSettings {
	out := api.RoundUpSettings{
		Enabled: r.Enabled, GoalId: r.GoalID, RoundTo: api.RoundUpSettingsRoundTo(strconv.FormatInt(r.RoundTo, 10)),
		Sources: make([]api.RoundUpSettingsSources, len(r.Sources)),
	}
	for i, s := range r.Sources {
		out.Sources[i] = api.RoundUpSettingsSources(s)
	}
	return out
}

// GetRoundUps is GET /v1/savings/round-ups.
func (a *API) GetRoundUps(ctx context.Context, _ api.GetRoundUpsRequestObject) (api.GetRoundUpsResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	r, err := a.svc.RoundUps(ctx)
	if err != nil {
		return nil, err
	}
	return api.GetRoundUps200JSONResponse(roundUpsJSON(r)), nil
}

// SetRoundUps is PUT /v1/savings/round-ups.
func (a *API) SetRoundUps(ctx context.Context, req api.SetRoundUpsRequestObject) (api.SetRoundUpsResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	b := req.Body
	in := RoundUpSettings{Enabled: b.Enabled, GoalID: b.GoalId, Sources: make([]string, len(b.Sources))}
	switch b.RoundTo {
	case "10000":
		in.RoundTo = 10_000
	case "50000":
		in.RoundTo = 50_000
	case "100000":
		in.RoundTo = 100_000
	}
	for i, s := range b.Sources {
		in.Sources[i] = string(s)
	}
	r, err := a.svc.SetRoundUps(ctx, in)
	if err != nil {
		return nil, err
	}
	return api.SetRoundUps200JSONResponse(roundUpsJSON(r)), nil
}
