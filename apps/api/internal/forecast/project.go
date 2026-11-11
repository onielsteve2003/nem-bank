package forecast

import (
	"fmt"
	"math"
	"slices"
	"strings"
	"time"
)

const (
	// alpha is the smoothing weight: today's spending counts for a fifth, and the weight of a
	// day halves roughly every three days back. High enough to follow a change in habits,
	// low enough that one big shop does not move the forecast.
	alpha = 0.2
	// minSmoothDays is how much history smoothing needs. A younger account gets the plain
	// average, which is the non-AI fallback and says so.
	minSmoothDays = 14
	// bandZ is the 80% interval of a normal error: the band holds the balance 4 days in 5.
	bandZ = 1.28
	// windowDays is how far ahead the forecast looks.
	windowDays = 30
	// capPercentile limits a single huge day (rent, a car) to what the busiest ordinary days
	// look like, so it does not read as a daily habit.
	capPercentile = 95
)

// Input is everything a projection needs, as plain values.
type Input struct {
	// Today is a Lagos day. Daily[len-1] is yesterday's spending; Daily[0] is the oldest day.
	Today time.Time
	// Balance is the naira available now, in kobo.
	Balance int64
	// Daily is naira spent per day in kobo, with subscription charges already left out
	// (they are added back on their own dates).
	Daily []int64
	// Salary is the naira salary credits seen lately.
	Salary []Credit
	// Subs are the detected subscriptions; only naira ones are projected.
	Subs []Subscription
	// Smooth turns exponential smoothing on; off, the plain average is used.
	Smooth bool
}

// Credit is a salary credit.
type Credit struct {
	Amount int64
	At     time.Time
}

// Point is a projected end-of-day balance with its band.
type Point struct {
	Date               time.Time
	Balance, Low, High int64
}

// Upcoming is a known recurring item inside the window.
type Upcoming struct {
	Label  string
	Amount int64
	Date   time.Time
	Credit bool
}

// Result is a projection.
type Result struct {
	NextPayday   *time.Time
	SalaryAmount int64
	DailySpend   int64
	Smoothed     bool
	Points       []Point
	Upcoming     []Upcoming
	HistoryDays  int
	Explanation  string
}

// Project forecasts the balance day by day.
//
// Each day: balance falls by the smoothed daily spend plus any subscription due that day,
// and rises by salary on payday. The band is the 80% interval of the cumulative error, which
// grows with the square root of the days ahead because daily errors are independent.
func Project(in Input) Result {
	history := capOutliers(in.Daily)
	smoothed := in.Smooth && len(history) >= minSmoothDays
	level, sigma := plainAverage(history)
	if smoothed {
		level, sigma = smooth(history)
	}
	daily := int64(math.Round(level))

	payday, salary := nextPayday(in.Today, in.Salary)
	end := windowDays
	if payday != nil {
		if d := daysBetween(in.Today, *payday); d > end {
			end = d
		}
	}

	var res Result
	res.DailySpend, res.Smoothed, res.HistoryDays = daily, smoothed, len(history)
	res.SalaryAmount = salary
	res.NextPayday = payday
	res.Upcoming = upcoming(in, payday, salary, end)

	dueOn := map[time.Time]int64{}
	for _, u := range res.Upcoming {
		if u.Credit {
			dueOn[u.Date] += u.Amount
		} else {
			dueOn[u.Date] -= u.Amount
		}
	}
	balance := in.Balance
	for h := 1; h <= end; h++ {
		date := in.Today.AddDate(0, 0, h)
		balance += dueOn[date] - daily
		band := int64(math.Round(bandZ * sigma * math.Sqrt(float64(h))))
		res.Points = append(res.Points, Point{Date: date, Balance: balance, Low: balance - band, High: balance + band})
	}
	res.Explanation = explain(res)
	return res
}

// upcoming lists the recurring items inside the window: each subscription as many times as
// it falls in the window, and each payday.
func upcoming(in Input, payday *time.Time, salary int64, end int) []Upcoming {
	last := in.Today.AddDate(0, 0, end)
	tomorrow := in.Today.AddDate(0, 0, 1)
	var out []Upcoming
	for _, s := range in.Subs {
		if s.Currency != "NGN" {
			continue
		}
		due := s.Next
		// An overdue charge may still land: expect it tomorrow rather than in the past.
		if due.Before(tomorrow) {
			due = tomorrow
		}
		for !due.After(last) {
			out = append(out, Upcoming{Label: s.Merchant, Amount: s.Amount, Date: due})
			due = s.Advance(due)
		}
	}
	for p := payday; p != nil && !p.After(last); {
		out = append(out, Upcoming{Label: "Salary", Amount: salary, Date: *p, Credit: true})
		next := paydayAfter(*p, p.Day())
		p = &next
	}
	slices.SortStableFunc(out, func(a, b Upcoming) int { return a.Date.Compare(b.Date) })
	return out
}

// nextPayday reads the pay day from salary credits: the usual day of the month, if salary
// arrived in at least two different months. Months are short, so a day past the end of the
// month (the 31st) means the last day.
func nextPayday(today time.Time, credits []Credit) (*time.Time, int64) {
	months := map[[2]int]bool{}
	var doms []int
	var amounts []int64
	for _, c := range credits {
		d := Day(c.At)
		months[[2]int{d.Year(), int(d.Month())}] = true
		doms = append(doms, d.Day())
		amounts = append(amounts, c.Amount)
	}
	if len(months) < 2 {
		return nil, 0
	}
	dom := medianInt(doms)
	p := paydayOn(today.Year(), today.Month(), dom)
	if !p.After(today) {
		p = paydayAfter(p, dom)
	}
	return &p, medianInt64(amounts)
}

// paydayOn is the pay day in a month, clamped to the month's last day.
func paydayOn(year int, month time.Month, dom int) time.Time {
	last := time.Date(year, month+1, 0, 0, 0, 0, 0, time.UTC).Day()
	return time.Date(year, month, min(dom, last), 0, 0, 0, 0, time.UTC)
}

func paydayAfter(p time.Time, dom int) time.Time {
	first := time.Date(p.Year(), p.Month()+1, 1, 0, 0, 0, 0, time.UTC)
	return paydayOn(first.Year(), first.Month(), dom)
}

// capOutliers limits each day to the 95th percentile of the days.
func capOutliers(daily []int64) []int64 {
	if len(daily) == 0 {
		return nil
	}
	sorted := slices.Clone(daily)
	slices.Sort(sorted)
	limit := sorted[(len(sorted)*capPercentile+99)/100-1]
	out := make([]int64, len(daily))
	for i, v := range daily {
		out[i] = v
		if limit > 0 && v > limit {
			out[i] = limit
		}
	}
	return out
}

// plainAverage is the mean and the standard deviation of the days.
func plainAverage(v []int64) (mean, sigma float64) {
	if len(v) == 0 {
		return 0, 0
	}
	for _, x := range v {
		mean += float64(x)
	}
	mean /= float64(len(v))
	for _, x := range v {
		sigma += (float64(x) - mean) * (float64(x) - mean)
	}
	return mean, math.Sqrt(sigma / float64(len(v)))
}

// smooth runs single exponential smoothing over the days, oldest first: level += alpha *
// (today - level). It starts from the first week's average. The returned sigma is the
// standard deviation of the one-step errors, so the band reflects how well the method has
// actually predicted this customer.
func smooth(v []int64) (level, sigma float64) {
	seed := min(7, len(v))
	for _, x := range v[:seed] {
		level += float64(x)
	}
	level /= float64(seed)
	var sq float64
	for _, x := range v[seed:] {
		e := float64(x) - level
		sq += e * e
		level += alpha * e
	}
	if n := len(v) - seed; n > 0 {
		sigma = math.Sqrt(sq / float64(n))
	}
	return level, sigma
}

// explain says in plain words what the numbers rest on.
func explain(r Result) string {
	var b strings.Builder
	switch {
	case r.HistoryDays == 0 || r.DailySpend == 0:
		b.WriteString("There is not enough spending history yet, so the balance is shown flat.")
	case r.Smoothed:
		fmt.Fprintf(&b, "You spend about %s a day, weighing recent days more (exponential smoothing over %d days).", naira(r.DailySpend), r.HistoryDays)
	default:
		fmt.Fprintf(&b, "You spend about %s a day, a plain average over %d days (not enough history to weigh recent days).", naira(r.DailySpend), r.HistoryDays)
	}
	if r.NextPayday != nil {
		fmt.Fprintf(&b, " Salary of about %s usually lands on %s.", naira(r.SalaryAmount), shortDate(*r.NextPayday))
	}
	subs, total := 0, int64(0)
	for _, u := range r.Upcoming {
		if !u.Credit && (r.NextPayday == nil || u.Date.Before(*r.NextPayday)) {
			subs++
			total += u.Amount
		}
	}
	if subs > 0 {
		if subs == 1 {
			fmt.Fprintf(&b, " 1 recurring charge (%s) leaves first.", naira(total))
		} else {
			fmt.Fprintf(&b, " %d recurring charges (%s) leave first.", subs, naira(total))
		}
	}
	for _, p := range r.Points {
		if p.Balance < 0 {
			fmt.Fprintf(&b, " Your balance may run out around %s unless money comes in.", shortDate(p.Date))
			break
		}
	}
	return b.String()
}

func shortDate(d time.Time) string { return fmt.Sprintf("%d %s", d.Day(), d.Month().String()[:3]) }

// naira formats kobo as ₦12,345 (whole naira, rounded half up: it is a sentence, not a ledger).
func naira(kobo int64) string {
	whole := (kobo + 50) / 100
	s := fmt.Sprintf("%d", whole)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return "₦" + s
}
