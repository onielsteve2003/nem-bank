package forecast

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/forecast/forecastdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

func day(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 0, 0, 0, 0, time.UTC) }

// at is noon Lagos time on a day.
func at(t time.Time) time.Time { return t.Add(11 * time.Hour) }

func charges(merchant string, amount int64, days ...time.Time) []Charge {
	out := make([]Charge, len(days))
	for i, d := range days {
		out[i] = Charge{ID: uuid.New(), Merchant: merchant, Currency: "NGN", Amount: amount, At: at(d)}
	}
	return out
}

func TestDetect(t *testing.T) {
	t.Parallel()
	user := uuid.New()
	today := day(2026, 11, 11)
	monthly := []time.Time{day(2026, 8, 5), day(2026, 9, 5), day(2026, 10, 5)}
	wandering := slicesConcat(charges("Electricity", 3_000_00, monthly[0]), charges("Electricity", 9_000_00, monthly[1]), charges("Electricity", 20_000_00, monthly[2]))
	priceChange := slicesConcat(charges("Spotify", 400_000, monthly[0], monthly[1]), charges("Spotify", 500_000, monthly[2]))

	tests := []struct {
		name    string
		charges []Charge
		want    Frequency // empty: not a subscription
	}{
		{"three monthly charges", charges("Netflix", 450_000, monthly...), Monthly},
		{"two monthly charges are not enough", charges("Netflix", 450_000, monthly[1:]...), ""},
		{"four weekly charges", charges("Gym pass", 1_500_00, day(2026, 10, 12), day(2026, 10, 19), day(2026, 10, 26), day(2026, 11, 2)), Weekly},
		{"two yearly charges", charges("Domain", 12_000_00, day(2024, 11, 20), day(2025, 11, 20)), Yearly},
		{"random gaps", charges("Shoprite", 450_000, day(2026, 8, 5), day(2026, 8, 9), day(2026, 10, 30)), ""},
		{"amounts that wander", wandering, ""},
		{"one price change is tolerated", priceChange, Monthly},
		{"stopped two cycles ago", charges("Old gym", 450_000, day(2026, 5, 5), day(2026, 6, 5), day(2026, 7, 5)), ""},
		{"a missed cycle is overdue, not cancelled", charges("Late", 450_000, day(2026, 7, 20), day(2026, 8, 20), day(2026, 9, 20)), Monthly},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := Detect(user, tc.charges, today)
			if tc.want == "" {
				if len(got) != 0 {
					t.Fatalf("detected %+v, want nothing", got)
				}
				return
			}
			if len(got) != 1 || got[0].Frequency != tc.want {
				t.Fatalf("got %+v, want one %s subscription", got, tc.want)
			}
		})
	}
}

func slicesConcat(parts ...[]Charge) []Charge {
	var out []Charge
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

func TestDetectDetails(t *testing.T) {
	t.Parallel()
	user := uuid.New()
	today := day(2026, 11, 11)
	cs := charges("Netflix", 450_000, day(2026, 8, 5), day(2026, 9, 5), day(2026, 10, 5))
	// The same merchant spelled differently is one merchant.
	cs[1].Merchant = "  NETFLIX "
	got := Detect(user, cs, today)
	if len(got) != 1 {
		t.Fatalf("got %d subscriptions", len(got))
	}
	s := got[0]
	if !s.Next.Equal(day(2026, 11, 5)) || s.Amount != 450_000 || len(s.Charges) != 3 {
		t.Fatalf("subscription = %+v", s)
	}
	if again := Detect(user, cs, today)[0]; again.ID != s.ID {
		t.Fatal("the ID changes between runs")
	}
	if other := Detect(uuid.New(), cs, today)[0]; other.ID == s.ID {
		t.Fatal("two customers share a subscription ID")
	}
}

func TestMonthlyAmount(t *testing.T) {
	t.Parallel()
	tests := []struct {
		f      Frequency
		amount int64
		want   int64
	}{
		{Monthly, 450_000, 450_000},
		{Weekly, 100_000, 433_333}, // 52/12 of a week's charge, rounded half up
		{Yearly, 1_200_000, 100_000},
		{Yearly, 100_005, 8_334},
	}
	for _, tc := range tests {
		if got := (Subscription{Frequency: tc.f, Amount: tc.amount}).MonthlyAmount(); got != tc.want {
			t.Errorf("%s %d = %d, want %d", tc.f, tc.amount, got, tc.want)
		}
	}
}

func flat(n int, v int64) []int64 {
	out := make([]int64, n)
	for i := range out {
		out[i] = v
	}
	return out
}

func TestProjectFlatSpending(t *testing.T) {
	t.Parallel()
	r := Project(Input{Today: day(2026, 11, 11), Balance: 1_000_000_00, Daily: flat(60, 5_000_00), Smooth: true})
	if r.DailySpend != 5_000_00 || !r.Smoothed || len(r.Points) != 30 {
		t.Fatalf("result = %+v", r)
	}
	if got, want := r.Points[29].Balance, int64(1_000_000_00-30*5_000_00); got != want {
		t.Fatalf("day 30 balance = %d, want %d", got, want)
	}
	if r.Points[29].Low != r.Points[29].Balance || r.NextPayday != nil {
		t.Fatalf("a perfectly steady spender has no band and no payday: %+v", r.Points[29])
	}
}

func TestProjectSmoothingFollowsRecentChange(t *testing.T) {
	t.Parallel()
	daily := append(flat(70, 2_000_00), flat(20, 10_000_00)...)
	smooth := Project(Input{Today: day(2026, 11, 11), Daily: daily, Smooth: true})
	plain := Project(Input{Today: day(2026, 11, 11), Daily: daily, Smooth: false})
	if smooth.DailySpend <= plain.DailySpend {
		t.Fatalf("smoothed %d should be above the plain average %d after spending rose", smooth.DailySpend, plain.DailySpend)
	}
	if plain.Smoothed || !smooth.Smoothed {
		t.Fatal("Smoothed flag wrong")
	}
	if p := smooth.Points[29]; p.Low >= p.Balance || p.Balance >= p.High {
		t.Fatalf("band does not surround the balance: %+v", p)
	}
	if early, late := smooth.Points[0], smooth.Points[29]; late.High-late.Low <= early.High-early.Low {
		t.Fatal("the band should widen with distance")
	}
}

func TestProjectShortHistoryUsesAverage(t *testing.T) {
	t.Parallel()
	r := Project(Input{Today: day(2026, 11, 11), Daily: flat(5, 1_000_00), Smooth: true})
	if r.Smoothed || r.DailySpend != 1_000_00 {
		t.Fatalf("result = %+v", r)
	}
}

func TestProjectCapsOneHugeDay(t *testing.T) {
	t.Parallel()
	daily := flat(60, 2_000_00)
	daily[10] = 900_000_00 // a car
	r := Project(Input{Today: day(2026, 11, 11), Daily: daily})
	if r.DailySpend != 2_000_00 {
		t.Fatalf("daily spend = %d: one huge day must not become a habit", r.DailySpend)
	}
}

func TestProjectSalaryAndSubscriptions(t *testing.T) {
	t.Parallel()
	today := day(2026, 11, 11)
	monthStep := func(t time.Time) time.Time { return t.AddDate(0, 1, 0) }
	sub := Subscription{Merchant: "Netflix", Currency: "NGN", Amount: 4_500_00, Frequency: Monthly, Next: day(2026, 11, 15), step: monthStep}
	usd := Subscription{Merchant: "Figma", Currency: "USD", Amount: 1_500, Frequency: Monthly, Next: day(2026, 11, 16), step: monthStep}
	r := Project(Input{
		Today: today, Balance: 100_000_00, Daily: flat(60, 1_000_00),
		Salary: []Credit{{500_000_00, at(day(2026, 9, 25))}, {500_000_00, at(day(2026, 10, 25))}},
		Subs:   []Subscription{sub, usd},
	})
	if r.NextPayday == nil || !r.NextPayday.Equal(day(2026, 11, 25)) || r.SalaryAmount != 500_000_00 {
		t.Fatalf("payday = %v amount %d", r.NextPayday, r.SalaryAmount)
	}
	if len(r.Upcoming) != 2 || r.Upcoming[0].Label != "Netflix" || !r.Upcoming[1].Credit {
		t.Fatalf("upcoming = %+v (foreign-currency subscriptions must be left out)", r.Upcoming)
	}
	byDate := map[time.Time]Point{}
	for _, p := range r.Points {
		byDate[p.Date] = p
	}
	before, on := byDate[day(2026, 11, 24)], byDate[day(2026, 11, 25)]
	if on.Balance-before.Balance != 500_000_00-1_000_00 {
		t.Fatalf("salary day moved the balance by %d", on.Balance-before.Balance)
	}
	if got := byDate[day(2026, 11, 14)].Balance - byDate[day(2026, 11, 15)].Balance; got != 4_500_00+1_000_00 {
		t.Fatalf("the Netflix day cost %d", got)
	}
}

func TestPaydayNeedsTwoMonths(t *testing.T) {
	t.Parallel()
	today := day(2026, 11, 11)
	if p, _ := nextPayday(today, []Credit{{100, at(day(2026, 10, 25))}}); p != nil {
		t.Fatal("one salary is not a pattern")
	}
	// Salary on the 31st lands on the last day of shorter months.
	p, _ := nextPayday(today, []Credit{{100, at(day(2026, 8, 31))}, {100, at(day(2026, 10, 31))}})
	if p == nil || !p.Equal(day(2026, 11, 30)) {
		t.Fatalf("payday = %v, want 30 Nov", p)
	}
	// A payday already past this month rolls to the next.
	p, _ = nextPayday(day(2026, 11, 26), []Credit{{100, at(day(2026, 9, 25))}, {100, at(day(2026, 10, 25))}})
	if p == nil || !p.Equal(day(2026, 12, 25)) {
		t.Fatalf("payday = %v, want 25 Dec", p)
	}
}

func TestExplanation(t *testing.T) {
	t.Parallel()
	r := Project(Input{Today: day(2026, 11, 11), Balance: 10_000_00, Daily: flat(60, 1_000_00), Smooth: true})
	if want := "Your balance may run out around 22 Nov"; !strings.Contains(r.Explanation, want) {
		t.Fatalf("explanation %q lacks %q", r.Explanation, want)
	}
	if empty := Project(Input{Today: day(2026, 11, 11)}); !strings.Contains(empty.Explanation, "not enough spending history") {
		t.Fatalf("empty history explanation = %q", empty.Explanation)
	}
}

func TestNairaFormat(t *testing.T) {
	t.Parallel()
	for in, want := range map[int64]string{0: "₦0", 99: "₦1", 5_000_00: "₦5,000", 123_456_700: "₦1,234,567"} {
		if got := naira(in); got != want {
			t.Errorf("naira(%d) = %q, want %q", in, got, want)
		}
	}
}

// ---- service ----------------------------------------------------------------------------

type fakeQueries struct {
	created time.Time
	cand    []forecastdb.RecurringCandidatesRow
	spend   []forecastdb.SpendingSinceRow
	salary  []forecastdb.SalaryCreditsRow
}

func (f fakeQueries) UserCreatedAt(context.Context, uuid.UUID) (time.Time, error) {
	return f.created, nil
}
func (f fakeQueries) RecurringCandidates(context.Context, forecastdb.RecurringCandidatesParams) ([]forecastdb.RecurringCandidatesRow, error) {
	return f.cand, nil
}
func (f fakeQueries) SpendingSince(context.Context, forecastdb.SpendingSinceParams) ([]forecastdb.SpendingSinceRow, error) {
	return f.spend, nil
}
func (f fakeQueries) SalaryCredits(context.Context, forecastdb.SalaryCreditsParams) ([]forecastdb.SalaryCreditsRow, error) {
	return f.salary, nil
}

type fakeAccounts struct{ balance int64 }

func (f fakeAccounts) List(context.Context) ([]accounts.View, error) {
	v := accounts.View{Available: money.New(f.balance, money.NGN)}
	v.Currency = "NGN"
	return []accounts.View{v}, nil
}

type fakeCustomers struct{ duress bool }

func (f fakeCustomers) CustomerProfile(context.Context, uuid.UUID) (identity.CustomerProfile, error) {
	return identity.CustomerProfile{InDuress: f.duress}, nil
}

func signedIn() context.Context {
	return identity.WithPrincipal(context.Background(), identity.Principal{UserID: uuid.New()})
}

func TestServiceDoesNotCountSubscriptionsAsEverydaySpending(t *testing.T) {
	t.Parallel()
	now := at(day(2026, 11, 11))
	var cand []forecastdb.RecurringCandidatesRow
	var spend []forecastdb.SpendingSinceRow
	for _, d := range []time.Time{day(2026, 8, 5), day(2026, 9, 5), day(2026, 10, 5)} {
		id := uuid.New()
		cand = append(cand, forecastdb.RecurringCandidatesRow{ID: id, Currency: "NGN", AmountMinor: 450_000, CreatedAt: at(d), Merchant: "Netflix"})
		spend = append(spend, forecastdb.SpendingSinceRow{ID: id, AmountMinor: 450_000, CreatedAt: at(d)})
	}
	for d := 1; d <= 60; d++ {
		spend = append(spend, forecastdb.SpendingSinceRow{ID: uuid.New(), AmountMinor: 1_000_00, CreatedAt: at(day(2026, 11, 11).AddDate(0, 0, -d))})
	}
	svc, err := NewService(Config{
		Queries:  fakeQueries{created: now.AddDate(0, 0, -200), cand: cand, spend: spend},
		Accounts: fakeAccounts{balance: 200_000_00}, Customers: fakeCustomers{}, Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	r, err := svc.Forecast(signedIn())
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Upcoming) != 1 || r.Upcoming[0].Label != "Netflix" {
		t.Fatalf("upcoming = %+v", r.Upcoming)
	}
	// Spending has been ₦1,000 a day lately. The ₦4,500 Netflix charges (added back as
	// upcoming) must not lift it.
	if r.DailySpend > 1_000_00 || r.DailySpend < 950_00 {
		t.Fatalf("daily spend = %d", r.DailySpend)
	}
	if _, err := svc.Forecast(context.Background()); err == nil {
		t.Fatal("a request without a caller must be refused")
	}
}

func TestServiceNewCustomerHistoryStartsAtSignup(t *testing.T) {
	t.Parallel()
	now := at(day(2026, 11, 11))
	svc, _ := NewService(Config{
		Queries:  fakeQueries{created: now.AddDate(0, 0, -10), spend: []forecastdb.SpendingSinceRow{{ID: uuid.New(), AmountMinor: 10_000_00, CreatedAt: at(day(2026, 11, 10))}}},
		Accounts: fakeAccounts{balance: 1_000_00}, Customers: fakeCustomers{}, Now: func() time.Time { return now },
	})
	r, err := svc.Forecast(signedIn())
	if err != nil {
		t.Fatal(err)
	}
	if r.HistoryDays != 10 || r.Smoothed || r.DailySpend != 1_000_00 {
		t.Fatalf("history %d smoothed %v daily %d: the days before sign-up are not zero-spend days", r.HistoryDays, r.Smoothed, r.DailySpend)
	}
}

func TestServiceDuressShowsNothing(t *testing.T) {
	t.Parallel()
	now := at(day(2026, 11, 11))
	svc, _ := NewService(Config{
		Queries:  fakeQueries{created: now.AddDate(0, 0, -100), cand: []forecastdb.RecurringCandidatesRow{{ID: uuid.New(), Currency: "NGN", AmountMinor: 1, CreatedAt: now, Merchant: "x"}}},
		Accounts: fakeAccounts{balance: 5_000_00}, Customers: fakeCustomers{duress: true}, Now: func() time.Time { return now },
	})
	subs, err := svc.Subscriptions(signedIn())
	if err != nil || len(subs) != 0 {
		t.Fatalf("subs %v err %v", subs, err)
	}
	if r, _ := svc.Forecast(signedIn()); r.DailySpend != 0 {
		t.Fatal("duress view must not reveal real spending")
	}
}
