package bills

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

func TestSavedBillersKeepOnePerNumberAndBelongToTheirOwner(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(0)
	other := f.customer(0)

	a, err := f.svc.SaveBiller(c.ctx, "mtn-airtime", "0803 123 4567", " Mum ")
	if err != nil || a.Nickname != "Mum" || a.Category != "airtime" || a.CustomerName != nil {
		t.Fatalf("save = %+v, %v", a, err)
	}
	// The same number again renames it; nothing is duplicated.
	b, err := f.svc.SaveBiller(c.ctx, "mtn-airtime", "0803 123 4567", "Mummy")
	if err != nil || b.ID != a.ID || b.Nickname != "Mummy" {
		t.Fatalf("resave = %+v, %v", b, err)
	}
	// A meter carries the name on it.
	m, err := f.svc.SaveBiller(c.ctx, "ikeja-electric-prepaid", "12340000001", "Flat")
	if err != nil || m.CustomerName == nil || *m.CustomerName == "" {
		t.Fatalf("meter = %+v, %v", m, err)
	}
	if _, err := f.svc.SaveBiller(c.ctx, "no-such-biller", "1", "x"); !errors.Is(err, ErrBillerNotFound) {
		t.Fatalf("unknown biller: %v", err)
	}
	if _, err := f.svc.SaveBiller(c.ctx, "mtn-airtime", "0803 123 4567", ""); err == nil {
		t.Fatal("an empty nickname must be refused")
	}
	if list, err := f.svc.SavedBillers(c.ctx); err != nil || len(list) != 2 || list[0].ID != m.ID {
		t.Fatalf("list = %+v, %v (newest first)", list, err)
	}
	if list, _ := f.svc.SavedBillers(other.ctx); len(list) != 0 {
		t.Fatalf("another customer sees %d billers", len(list))
	}
	if err := f.svc.DeleteSavedBiller(other.ctx, a.ID); !errors.Is(err, ErrSavedBillerNotFound) {
		t.Fatalf("another customer deleting: %v", err)
	}
	if err := f.svc.DeleteSavedBiller(c.ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.DeleteSavedBiller(c.ctx, a.ID); !errors.Is(err, ErrSavedBillerNotFound) {
		t.Fatalf("second delete: %v", err)
	}
	// The cap holds.
	for i := range maxSavedBillers {
		num := "08031230" + string(rune('0'+i/10)) + string(rune('0'+i%10))
		if _, err := f.svc.SaveBiller(c.ctx, "mtn-airtime", num, "n"); err != nil && i < maxSavedBillers-1 {
			t.Fatalf("save %d: %v", i, err)
		}
	}
	if _, err := f.svc.SaveBiller(c.ctx, "mtn-airtime", "08039999991", "over"); err == nil {
		t.Fatal("past the cap must be refused")
	}
}

func TestScheduledBillsRunOnceClaimedAndRepeat(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00)
	start := f.clk.Now().Add(time.Hour)
	req := PayRequest{BillerID: "mtn-airtime", CustomerID: "0803 123 4567", Amount: naira(500), Source: c.ngn}

	if _, err := f.svc.CreateSchedule(c.ctx, NewSchedule{Pay: req, Frequency: "daily", StartAt: f.clk.Now().Add(-time.Hour)}); err == nil {
		t.Fatal("a start in the past must be refused")
	}
	bad := req
	bad.CustomerID = "12"
	if _, err := f.svc.CreateSchedule(c.ctx, NewSchedule{Pay: bad, Frequency: "daily", StartAt: start}); err == nil {
		t.Fatal("a bad phone number must be refused when the schedule is made")
	}
	daily, err := f.svc.CreateSchedule(c.ctx, NewSchedule{Pay: req, Frequency: "daily", StartAt: start})
	if err != nil || daily.Status != "active" || daily.NextRunAt == nil || !daily.NextRunAt.Equal(start) {
		t.Fatalf("create = %+v, %v", daily, err)
	}
	once, err := f.svc.CreateSchedule(c.ctx, NewSchedule{Pay: req, Frequency: "once", StartAt: start})
	if err != nil {
		t.Fatal(err)
	}

	// Nothing is due yet.
	if err := f.svc.RunDueSchedules(t.Context()); err != nil || f.balance(c.ngn) != 10_000_00 {
		t.Fatalf("early run: %v, balance %d", err, f.balance(c.ngn))
	}
	f.clk.advance(90 * time.Minute)
	if err := f.svc.RunDueSchedules(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got := f.balance(c.ngn); got != 9_000_00 { // two schedules, ₦500 each
		t.Fatalf("balance after the first run = %d, want 900000", got)
	}
	// Running again in the same minute pays nothing more: each run was claimed.
	if err := f.svc.RunDueSchedules(t.Context()); err != nil || f.balance(c.ngn) != 9_000_00 {
		t.Fatalf("second pass: %v, balance %d", err, f.balance(c.ngn))
	}
	list, err := f.svc.Schedules(c.ctx)
	if err != nil || len(list) != 2 {
		t.Fatalf("schedules = %+v, %v", list, err)
	}
	for _, sc := range list {
		switch sc.ID {
		case once.ID:
			if sc.Status != "completed" || sc.NextRunAt != nil {
				t.Fatalf("one-off = %+v", sc)
			}
		case daily.ID:
			if sc.Status != "active" || sc.NextRunAt == nil || !sc.NextRunAt.Equal(start.AddDate(0, 0, 1)) {
				t.Fatalf("daily = %+v", sc)
			}
		}
	}

	// A day later the daily one runs again; when money runs out the run is skipped, not retried.
	f.clk.advance(24 * time.Hour)
	if err := f.svc.RunDueSchedules(t.Context()); err != nil || f.balance(c.ngn) != 8_500_00 {
		t.Fatalf("next day: %v, balance %d", err, f.balance(c.ngn))
	}
	poor := f.customer(100_00)
	skipped, err := f.svc.CreateSchedule(poor.ctx, NewSchedule{Pay: PayRequest{BillerID: "mtn-airtime", CustomerID: "0803 123 4567", Amount: naira(500), Source: poor.ngn}, Frequency: "daily", StartAt: f.clk.Now().Add(time.Minute)})
	if err != nil {
		t.Fatal(err)
	}
	f.clk.advance(2 * time.Minute)
	if err := f.svc.RunDueSchedules(t.Context()); err != nil {
		t.Fatalf("a refused payment is recorded, not an error: %v", err)
	}
	var result *string
	var next *time.Time
	if err := f.pool.QueryRow(t.Context(), `SELECT last_result, next_run_at FROM bill_schedules WHERE id = $1`, skipped.ID).Scan(&result, &next); err != nil {
		t.Fatal(err)
	}
	if result == nil || *result == "completed" || next == nil || f.balance(poor.ngn) != 100_00 {
		t.Fatalf("skipped run: result = %v, next = %v, balance %d", result, next, f.balance(poor.ngn))
	}

	// Cancel: owner only, and cancelling twice is fine.
	stranger := identity.WithPrincipal(t.Context(), identity.Principal{UserID: uuid.New()})
	if err := f.svc.CancelSchedule(stranger, daily.ID); !errors.Is(err, problem.NotFound("Scheduled bill")) {
		t.Fatalf("stranger cancelling: %v", err)
	}
	if err := f.svc.CancelSchedule(c.ctx, daily.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.CancelSchedule(c.ctx, daily.ID); err != nil {
		t.Fatalf("cancelling twice: %v", err)
	}
	f.clk.advance(48 * time.Hour)
	if err := f.svc.RunDueSchedules(t.Context()); err != nil || f.balance(c.ngn) != 8_500_00 {
		t.Fatalf("after cancel: %v, balance %d", err, f.balance(c.ngn))
	}
}
