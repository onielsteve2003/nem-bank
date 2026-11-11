package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/assistant/assistantdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

// A tool is a function the model may call. The model supplies only the arguments; who the
// customer is comes from the request, so no argument can name another customer. Tool results
// are aggregates and short labels: no names of people, account numbers, narrations or
// balances of other accounts.
type tool struct {
	def ToolDef
	run func(ctx context.Context, env *toolEnv, args json.RawMessage) (any, error)
}

// toolEnv is what a running tool can touch: the service, the caller, and the blocks (charts,
// action cards) the reply will carry next to the model's words.
type toolEnv struct {
	svc    *Service
	userID uuid.UUID
	convID uuid.UUID
	vault  *Vault
	now    time.Time
	blocks []api.AssistantBlock
}

func obj(props map[string]any, required ...string) map[string]any {
	o := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		o["required"] = required
	}
	return o
}

func (s *Service) tools() []tool {
	return []tool{
		{ToolDef{Name: "get_balances", Description: "The customer's balance in each of their accounts.", Parameters: obj(map[string]any{})}, toolBalances},
		{ToolDef{Name: "spending_by_category", Description: "How much the customer spent in each category over a period. Also shows a chart.",
			Parameters: obj(map[string]any{"period": map[string]any{"type": "string", "enum": []string{"this_month", "last_month", "last_30_days"}}}, "period")}, toolSpending},
		{ToolDef{Name: "cash_flow_forecast", Description: "Where the customer's naira balance is heading over the next 30 days, with salary and subscriptions. Also shows a chart.", Parameters: obj(map[string]any{})}, toolForecast},
		{ToolDef{Name: "list_subscriptions", Description: "The recurring charges found in the customer's card and bill payments.", Parameters: obj(map[string]any{})}, toolSubscriptions},
		{ToolDef{Name: "prepare_transfer", Description: "Draft a naira transfer to one of the customer's SAVED beneficiaries. This does NOT send money: the customer sees a card and confirms it with their PIN. Use the recipient exactly as the customer wrote it.",
			Parameters: obj(map[string]any{
				"recipient":    map[string]any{"type": "string", "description": "Saved beneficiary name or nickname, or a placeholder like [NEMTAG_1] exactly as written"},
				"amount_naira": map[string]any{"type": "number", "description": "Amount in naira, for example 5000 or 2500.50"},
				"reason":       map[string]any{"type": "string", "description": "Optional short reason, for example food"},
			}, "recipient", "amount_naira")}, toolPrepareTransfer},
		{ToolDef{Name: "prepare_card_freeze", Description: "Draft freezing one of the customer's cards. This does NOT freeze it: the customer confirms on the card shown.",
			Parameters: obj(map[string]any{"card": map[string]any{"type": "string", "description": "Last four digits or the card's nickname"}}, "card")}, toolPrepareCardFreeze},
	}
}

// decodeArgs parses tool arguments strictly: an unknown field is a mistake or an attack.
func decodeArgs(raw json.RawMessage, into any) error {
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = json.RawMessage("{}")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	return dec.Decode(into)
}

func naira(minor int64) string { return "NGN " + money.New(minor, money.NGN).FormatMajor() }

func toolBalances(ctx context.Context, env *toolEnv, _ json.RawMessage) (any, error) {
	views, err := env.svc.accounts.List(ctx)
	if err != nil {
		return nil, err
	}
	type line struct {
		Currency  string `json:"currency"`
		Available string `json:"available"`
	}
	out := make([]line, 0, len(views))
	for _, v := range views {
		out = append(out, line{Currency: v.Currency, Available: v.Available.FormatMajor()})
	}
	return map[string]any{"accounts": out}, nil
}

var categoryLabels = map[string]string{
	"airtime_data": "Airtime & data", "bills_utilities": "Bills & utilities",
	"rent_housing": "Rent & housing", "fees_charges": "Fees & charges", "salary_income": "Salary",
}

func categoryLabel(c string) string {
	if l, ok := categoryLabels[c]; ok {
		return l
	}
	c = strings.ReplaceAll(c, "_", " ")
	if c == "" {
		return c
	}
	return strings.ToUpper(c[:1]) + c[1:]
}

var lagos = time.FixedZone("WAT", 60*60)

func toolSpending(ctx context.Context, env *toolEnv, raw json.RawMessage) (any, error) {
	var a struct {
		Period string `json:"period"`
	}
	if err := decodeArgs(raw, &a); err != nil {
		return nil, err
	}
	y, m, _ := env.now.In(lagos).Date()
	from, to := time.Date(y, m, 1, 0, 0, 0, 0, lagos), env.now
	switch a.Period {
	case "this_month":
	case "last_month":
		from, to = from.AddDate(0, -1, 0), from
	case "last_30_days":
		from = env.now.AddDate(0, 0, -30)
	default:
		return nil, errors.New("period must be this_month, last_month or last_30_days")
	}
	rows, err := env.svc.store.SpendingByCategory(ctx, assistantdb.SpendingByCategoryParams{UserID: env.userID, FromTime: from, ToTime: to})
	if err != nil {
		return nil, err
	}
	chart := api.AssistantChartBlock{Type: api.Chart, Chart: api.Donut, Title: "Spending by category"}
	type line struct {
		Category string `json:"category"`
		Total    string `json:"total"`
	}
	lines := make([]line, 0, len(rows))
	var total int64
	for _, r := range rows {
		total += r.TotalMinor
		lines = append(lines, line{categoryLabel(r.Category), naira(r.TotalMinor)})
		chart.Series = append(chart.Series, struct {
			Amount api.Money `json:"amount"`
			Label  string    `json:"label"`
		}{Amount: api.Money{AmountMinor: fmt.Sprint(r.TotalMinor), Currency: api.CurrencyCode(money.NGN)}, Label: categoryLabel(r.Category)})
	}
	if len(rows) > 0 {
		env.addChart(chart)
	}
	return map[string]any{"period": a.Period, "total": naira(total), "categories": lines}, nil
}

func (e *toolEnv) addChart(c api.AssistantChartBlock) {
	var b api.AssistantBlock
	if err := b.FromAssistantChartBlock(c); err == nil {
		e.blocks = append(e.blocks, b)
	}
}

func toolForecast(ctx context.Context, env *toolEnv, _ json.RawMessage) (any, error) {
	r, err := env.svc.forecast.Forecast(ctx)
	if err != nil {
		return nil, err
	}
	if len(r.Points) == 0 {
		return map[string]any{"note": "not enough history yet"}, nil
	}
	chart := api.AssistantChartBlock{Type: api.Chart, Chart: api.Line, Title: "Projected balance"}
	for i := 6; i < len(r.Points); i += 7 { // one point a week keeps the chart readable
		p := r.Points[i]
		chart.Series = append(chart.Series, struct {
			Amount api.Money `json:"amount"`
			Label  string    `json:"label"`
		}{Amount: api.Money{AmountMinor: fmt.Sprint(p.Balance), Currency: api.CurrencyCode(money.NGN)}, Label: p.Date.Format("2 Jan")})
	}
	env.addChart(chart)
	end := r.Points[len(r.Points)-1]
	out := map[string]any{
		"projected_balance_in_30_days": naira(end.Balance), "likely_range": naira(end.Low) + " to " + naira(end.High),
		"explanation": r.Explanation,
	}
	if r.NextPayday != nil {
		out["next_payday"] = r.NextPayday.Format("2006-01-02")
	}
	return out, nil
}

func toolSubscriptions(ctx context.Context, env *toolEnv, _ json.RawMessage) (any, error) {
	subs, err := env.svc.forecast.Subscriptions(ctx)
	if err != nil {
		return nil, err
	}
	type line struct {
		Merchant  string `json:"merchant"`
		Amount    string `json:"amount"`
		Frequency string `json:"frequency"`
		Next      string `json:"next_charge"`
	}
	out := make([]line, 0, len(subs))
	var monthly int64
	for _, s := range subs {
		// The merchant name comes from a card statement: cleaned before a model reads it.
		out = append(out, line{CleanLabel(s.Merchant), s.Currency + " " + money.New(s.Amount, money.Currency(s.Currency)).FormatMajor(), string(s.Frequency), s.Next.Format("2006-01-02")})
		if s.Currency == string(money.NGN) {
			monthly += s.MonthlyAmount()
		}
	}
	return map[string]any{"subscriptions": out, "naira_cost_per_month": naira(monthly)}, nil
}

// ---- prepared actions -------------------------------------------------------------------

const maxPreparedNaira = 10_000_000_00 // ₦10m: a sanity ceiling; the limits engine decides at confirm time

func toolPrepareTransfer(ctx context.Context, env *toolEnv, raw json.RawMessage) (any, error) {
	var a struct {
		Recipient   string      `json:"recipient"`
		AmountNaira json.Number `json:"amount_naira"`
		Reason      string      `json:"reason"`
	}
	if err := decodeArgs(raw, &a); err != nil {
		return nil, err
	}
	amount, err := money.ParseMajor(a.AmountNaira.String(), money.NGN)
	if err != nil || !amount.IsPositive() || amount.Amount() > maxPreparedNaira {
		return map[string]any{"status": "rejected", "reason": "the amount must be a positive naira figure, at most 10,000,000"}, nil
	}
	if ok, err := env.svc.canPrepare(ctx, env.userID); err != nil {
		return nil, err
	} else if !ok {
		return map[string]any{"status": "rejected", "reason": "the customer already has pending actions to confirm or discard first"}, nil
	}
	// The model saw a placeholder for a @nemtag; the lookup needs the real one.
	query := strings.TrimSpace(env.vault.Restore(a.Recipient))
	if query == "" {
		return map[string]any{"status": "rejected", "reason": "no recipient given"}, nil
	}
	matches, err := env.svc.beneficiaries.Find(ctx, query)
	if err != nil {
		return nil, err
	}
	if len(matches) != 1 {
		// Names stay on our side: the model learns only how many matched.
		return map[string]any{"status": "no_unique_match", "matches": len(matches), "advice": "ask the customer to pick a saved beneficiary or use the Send money screen"}, nil
	}
	ngn, err := env.svc.nairaAccount(ctx)
	if err != nil {
		return nil, err
	}
	reason := CleanLabel(a.Reason)
	narration := reason
	req := api.CreateTransferRequest{Amount: api.Money{AmountMinor: fmt.Sprint(amount.Amount()), Currency: api.CurrencyCode(money.NGN)}, SourceAccountId: ngn}
	if narration != "" {
		req.Narration = &narration
	}
	if err := req.Destination.FromBeneficiaryDestination(api.BeneficiaryDestination{Kind: api.BeneficiaryDestinationKindBeneficiary, BeneficiaryId: matches[0].ID}); err != nil {
		return nil, err
	}
	summary := "Send ₦" + groupThousands(amount) + " to " + matches[0].Label
	if reason != "" {
		summary += " for " + reason
	}
	var details api.PreparedAction_Details
	if err := details.FromCreateTransferRequest(req); err != nil {
		return nil, err
	}
	if err := env.svc.saveAction(ctx, env, api.PreparedActionKind("transfer"), summary, details); err != nil {
		return nil, err
	}
	// The model is told, plainly, that nothing has moved.
	return map[string]any{"status": "prepared", "note": "A confirmation card is now shown to the customer. No money has moved. Tell them to review the card and confirm with their PIN."}, nil
}

func toolPrepareCardFreeze(ctx context.Context, env *toolEnv, raw json.RawMessage) (any, error) {
	var a struct {
		Card string `json:"card"`
	}
	if err := decodeArgs(raw, &a); err != nil {
		return nil, err
	}
	if ok, err := env.svc.canPrepare(ctx, env.userID); err != nil {
		return nil, err
	} else if !ok {
		return map[string]any{"status": "rejected", "reason": "the customer already has pending actions to confirm or discard first"}, nil
	}
	cards, err := env.svc.cards.OpenCards(ctx)
	if err != nil {
		return nil, err
	}
	want := strings.ToLower(strings.TrimSpace(a.Card))
	var hits []CardRef
	for _, c := range cards {
		if want != "" && (c.Last4 == want || strings.ToLower(c.Nickname) == want) {
			hits = append(hits, c)
		}
	}
	if len(hits) != 1 {
		return map[string]any{"status": "no_unique_match", "matches": len(hits), "advice": "ask for the last four digits of the card"}, nil
	}
	var details api.PreparedAction_Details
	if err := details.FromPreparedActionDetails4(api.PreparedActionDetails4{CardId: hits[0].ID}); err != nil {
		return nil, err
	}
	if err := env.svc.saveAction(ctx, env, api.PreparedActionKind("card_freeze"), "Freeze card ending "+hits[0].Last4, details); err != nil {
		return nil, err
	}
	return map[string]any{"status": "prepared", "note": "A confirmation card is now shown to the customer. The card is not frozen yet."}, nil
}

func groupThousands(m money.Money) string {
	s := m.FormatMajor()
	whole, frac, _ := strings.Cut(s, ".")
	for i := len(whole) - 3; i > 0; i -= 3 {
		whole = whole[:i] + "," + whole[i:]
	}
	if frac == "" || strings.Trim(frac, "0") == "" {
		return whole
	}
	return whole + "." + frac
}
