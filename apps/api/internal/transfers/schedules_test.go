package transfers

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
)

// stepUps accepts the token "ok" any number of times.
type stepUps struct{}

func (stepUps) ConsumeStepUp(_ context.Context, _ pgx.Tx, _ uuid.UUID, purpose, token string) error {
	if token != "ok" || purpose != StepUpPurpose {
		return identity.ErrStepUpRequired
	}
	return nil
}

// clockFixture is a fixture whose clock the test moves.
type clockFixture struct {
	*fixture
	mu  sync.Mutex
	now time.Time
}

func newClockFixture(t *testing.T) *clockFixture {
	c := &clockFixture{now: time.Date(2026, 11, 9, 10, 0, 0, 0, time.UTC)}
	c.fixture = newFixtureWith(t, func(cfg *Config) {
		cfg.Now = func() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
		cfg.StepUps = stepUps{}
	})
	return c
}

func (c *clockFixture) advance(d time.Duration) { c.mu.Lock(); c.now = c.now.Add(d); c.mu.Unlock() }

func nemDest(number string) api.CreateBeneficiaryRequest_Destination {
	var d api.CreateBeneficiaryRequest_Destination
	if err := d.FromNemDestination(api.NemDestination{Kind: "nem", AccountNumber: number}); err != nil {
		panic(err)
	}
	return d
}

func (f *fixture) available(c customer) int64 {
	f.t.Helper()
	b, err := ledger.GetBalances(f.t.Context(), f.pool, c.account)
	if err != nil {
		f.t.Fatal(err)
	}
	return b.Available.Amount()
}

func TestBeneficiariesAreSavedListedAndRemoved(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu := f.customer("Tolu", "tolu", 0)
	ada := f.customer("Ada", "ada", 0)
	bolu := f.customer("Bolu", "bolu", 0)

	nick := "  Sis "
	b1, err := f.svc.CreateBeneficiary(tolu.ctx, nemDest(ada.number), &nick, false)
	if err != nil || b1.Kind != "nem" || b1.Name != "Ada Test" || *b1.Nickname != "Sis" || *b1.Nemtag != "ada" || b1.CoolingOffUntil == nil {
		t.Fatalf("saved = %+v, %v", b1, err)
	}
	_, err = f.svc.CreateBeneficiary(tolu.ctx, nemDest(ada.number), nil, false)
	wantProblem(t, err, "beneficiary_exists", "Ada Test is already in your beneficiaries.")
	_, err = f.svc.CreateBeneficiary(tolu.ctx, nemDest(tolu.number), nil, false)
	wantProblem(t, err, "validation_failed", "")
	b2, err := f.svc.CreateBeneficiary(tolu.ctx, nemDest(bolu.number), nil, true)
	if err != nil {
		t.Fatal(err)
	}

	// Favourites first.
	rows, page, err := f.svc.ListBeneficiaries(tolu.ctx, nil, nil, nil, ptr(1))
	if err != nil || len(rows) != 1 || rows[0].ID != b2.ID || page.NextCursor == nil {
		t.Fatalf("page 1 = %+v %+v, %v", rows, page, err)
	}
	rows, page, err = f.svc.ListBeneficiaries(tolu.ctx, nil, nil, page.NextCursor, ptr(1))
	if err != nil || len(rows) != 1 || rows[0].ID != b1.ID || page.NextCursor != nil {
		t.Fatalf("page 2 = %+v %+v, %v", rows, page, err)
	}
	if rows, _, _ := f.svc.ListBeneficiaries(tolu.ctx, nil, ptr("sis"), nil, nil); len(rows) != 1 || rows[0].ID != b1.ID {
		t.Fatalf("search = %+v", rows)
	}
	if rows, _, _ := f.svc.ListBeneficiaries(tolu.ctx, ptr(false), nil, nil, nil); len(rows) != 1 || rows[0].ID != b1.ID {
		t.Fatalf("not favourites = %+v", rows)
	}
	// Somebody else's list is their own.
	if rows, _, _ := f.svc.ListBeneficiaries(ada.ctx, nil, nil, nil, nil); len(rows) != 0 {
		t.Fatalf("ada sees %d", len(rows))
	}

	empty := ""
	u, err := f.svc.UpdateBeneficiary(tolu.ctx, b1.ID, &empty, ptr(true))
	if err != nil || u.Nickname != nil || !u.Favourite {
		t.Fatalf("updated = %+v, %v", u, err)
	}
	if _, err := f.svc.UpdateBeneficiary(ada.ctx, b1.ID, nil, ptr(false)); !errors.Is(err, ErrBeneficiaryNotFound) {
		t.Fatalf("someone else's: %v", err)
	}
	if err := f.svc.DeleteBeneficiary(tolu.ctx, b1.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.DeleteBeneficiary(tolu.ctx, b1.ID); !errors.Is(err, ErrBeneficiaryNotFound) {
		t.Fatalf("second delete: %v", err)
	}
}

func TestALargeFirstTransferToANewPayeeWaitsOutTheCoolingOff(t *testing.T) {
	t.Parallel()
	f := newClockFixture(t)
	tolu := f.customer("Tolu", "tolu", 30_000_000)
	ada := f.customer("Ada", "ada", 0)
	f.tier(tolu, 3)

	q, err := f.svc.Quote(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(15_000_000)})
	if err != nil || q.CoolingOff == nil || q.CoolingOff.Reason != "new_beneficiary" || q.CoolingOff.DelayMinutes != 30 {
		t.Fatalf("quote = %+v, %v", q.CoolingOff, err)
	}
	v, err := f.svc.Create(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(15_000_000), SaveBeneficiary: true})
	if err != nil {
		t.Fatal(err)
	}
	if v.Status != "delayed" || v.ReleaseAt == nil || !v.ReleaseAt.Equal(f.now.Add(30*time.Minute)) || v.HoldID == nil || v.BeneficiaryID == nil {
		t.Fatalf("delayed = %+v", v.Transfer)
	}
	if f.available(tolu) != 15_000_000 || f.balance(tolu) != 30_000_000 || f.balance(ada) != 0 {
		t.Fatalf("while delayed: available %d, ledger %d", f.available(tolu), f.balance(tolu))
	}
	if n := f.count(`SELECT count(*) FROM river_job WHERE kind = 'transfer_release' AND args->>'transfer_id' = $1`, v.ID.String()); n != 1 {
		t.Fatalf("release jobs = %d", n)
	}
	// Woken early, the job waits.
	var snooze *river.JobSnoozeError
	if err := f.svc.Release(t.Context(), v.ID); !errors.As(err, &snooze) {
		t.Fatalf("early release = %v", err)
	}

	f.advance(30 * time.Minute)
	if err := f.svc.Release(t.Context(), v.ID); err != nil {
		t.Fatal(err)
	}
	got, err := f.svc.Get(tolu.ctx, v.ID)
	if err != nil || got.Status != "completed" {
		t.Fatalf("released = %+v, %v", got.Transfer, err)
	}
	if s := statuses(got); s[len(s)-2] != "released" {
		t.Fatalf("timeline = %v", s)
	}
	if f.available(tolu) != 15_000_000 || f.balance(tolu) != 15_000_000 || f.balance(ada) != 14_995_000 {
		t.Fatalf("after release: available %d, ledger %d, ada %d", f.available(tolu), f.balance(tolu), f.balance(ada))
	}
	// Paid once, Ada is no longer new: the next large transfer goes at once.
	again, err := f.svc.Create(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(10_000_001)})
	if err != nil || again.Status != "completed" {
		t.Fatalf("second = %+v, %v", again.Transfer, err)
	}
	// Under the threshold a new payee is not held at all.
	bolu := f.customer("Bolu", "bolu", 0)
	if small, err := f.svc.Create(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toNem(bolu.number), Amount: ngn(1_000_000)}); err != nil || small.Status != "completed" {
		t.Fatalf("small = %+v, %v", small.Transfer, err)
	}
}

func TestStepUpSendsAndCancelReturns(t *testing.T) {
	t.Parallel()
	f := newClockFixture(t)
	tolu := f.customer("Tolu", "tolu", 50_000_000)
	ada := f.customer("Ada", "ada", 0)
	f.tier(tolu, 3)
	big := Request{SourceAccountID: tolu.account, Destination: toBank("058", "0123456789"), Amount: ngn(10_000_001)}

	// A step-up on the request skips the wait.
	r := big
	r.StepUpToken = "ok"
	if v, err := f.svc.Create(tolu.ctx, r); err != nil || v.Status != "processing" {
		t.Fatalf("stepped up = %+v, %v", v.Transfer, err)
	}
	// A bad token just means it waits.
	r.StepUpToken = "guess"
	waiting, err := f.svc.Create(tolu.ctx, r)
	if err != nil || waiting.Status != "delayed" {
		t.Fatalf("bad token = %+v, %v", waiting.Transfer, err)
	}
	if _, err := f.svc.StepUp(tolu.ctx, waiting.ID, "guess"); !errors.Is(err, identity.ErrStepUpRequired) {
		t.Fatalf("step-up with a bad token: %v", err)
	}
	if _, err := f.svc.StepUp(ada.ctx, waiting.ID, "ok"); !errors.Is(err, ErrTransferNotFound) {
		t.Fatalf("someone else's: %v", err)
	}
	f.advance(10 * time.Minute)
	sent, err := f.svc.StepUp(tolu.ctx, waiting.ID, "ok")
	if err != nil || sent.Status != "processing" || !sent.SagaDeadline.Equal(f.now.Add(DefaultSagaTimeout)) {
		t.Fatalf("after step-up = %+v, %v", sent.Transfer, err)
	}
	if _, err := f.svc.StepUp(tolu.ctx, waiting.ID, "ok"); !errors.Is(err, errNotWaiting) {
		t.Fatalf("second step-up: %v", err)
	}

	// Cancelled: hold released, limit given back, line failed.
	used := f.count(`SELECT used_minor FROM daily_limit_usage WHERE user_id = $1`, tolu.id)
	before := f.available(tolu)
	third, err := f.svc.Create(tolu.ctx, big)
	if err != nil || third.Status != "delayed" {
		t.Fatalf("third = %+v, %v", third.Transfer, err)
	}
	c, err := f.svc.Cancel(tolu.ctx, third.ID)
	if err != nil || c.Status != "cancelled" {
		t.Fatalf("cancelled = %+v, %v", c.Transfer, err)
	}
	if f.available(tolu) != before || f.count(`SELECT used_minor FROM daily_limit_usage WHERE user_id = $1`, tolu.id) != used {
		t.Fatalf("cancel kept money or limit: available %d (was %d)", f.available(tolu), before)
	}
	if again, err := f.svc.Cancel(tolu.ctx, third.ID); err != nil || again.Status != "cancelled" {
		t.Fatalf("cancel twice = %v", err)
	}
	if _, err := f.svc.Cancel(tolu.ctx, sent.ID); !errors.Is(err, errNotCancelled) {
		t.Fatalf("cancel a sent transfer: %v", err)
	}
	// The release job finds nothing to do once it was cancelled.
	f.advance(time.Hour)
	if err := f.svc.Release(t.Context(), third.ID); err != nil {
		t.Fatal(err)
	}
}

func TestSchedulesRunAsNormalTransfers(t *testing.T) {
	t.Parallel()
	f := newClockFixture(t)
	tolu := f.customer("Tolu", "tolu", 2_000_000)
	ada := f.customer("Ada", "ada", 0)
	ends := time.Date(2026, 11, 10, 0, 0, 0, 0, time.UTC)

	_, err := f.svc.CreateSchedule(tolu.ctx, NewSchedule{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(500_000),
		Frequency: "daily", StartAt: f.now.Add(-time.Hour)})
	if !errors.Is(err, errStartInPast) {
		t.Fatalf("past start: %v", err)
	}
	sch, err := f.svc.CreateSchedule(tolu.ctx, NewSchedule{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(1_500_000),
		Frequency: "daily", StartAt: f.now, EndsOn: &ends})
	if err != nil || sch.Status != "active" || sch.Narration != "Scheduled transfer to Ada Test" {
		t.Fatalf("schedule = %+v, %v", sch, err)
	}

	// First run: a normal transfer, then the next run is a day later.
	if err := f.svc.RunDue(t.Context()); err != nil {
		t.Fatal(err)
	}
	got, err := f.svc.GetSchedule(tolu.ctx, sch.ID)
	if err != nil || got.RunCount != 1 || got.NextRunAt == nil || !got.NextRunAt.Equal(f.now.Add(24*time.Hour)) {
		t.Fatalf("after run 1 = %+v, %v", got, err)
	}
	out, err := ScheduleJSON(got)
	if err != nil || out.LastRun == nil || out.LastRun.Status != "completed" || out.LastRun.TransferId == nil {
		t.Fatalf("last run = %+v, %v", out.LastRun, err)
	}
	if f.balance(tolu) != 500_000 || f.balance(ada) != 1_495_000 {
		t.Fatalf("balances %d, %d", f.balance(tolu), f.balance(ada))
	}
	// Running again before it is due does nothing.
	if err := f.svc.RunDue(t.Context()); err != nil {
		t.Fatal(err)
	}

	// Second run: not enough money. Recorded as failed, the schedule moves on and ends
	// (the next run would fall after ends_on).
	f.advance(24 * time.Hour)
	if err := f.svc.RunDue(t.Context()); err != nil {
		t.Fatal(err)
	}
	got, _ = f.svc.GetSchedule(tolu.ctx, sch.ID)
	out, _ = ScheduleJSON(got)
	if got.RunCount != 2 || got.Status != "completed" || got.NextRunAt != nil || out.LastRun.Status != "failed" || out.LastRun.TransferId != nil {
		t.Fatalf("after run 2 = %+v %+v", got, out.LastRun)
	}
	if n := f.count(`SELECT count(*) FROM outbox_events WHERE topic = 'schedule.run_skipped' AND aggregate_id = $1`, sch.ID.String()); n != 1 || f.balance(tolu) != 500_000 {
		t.Fatalf("skipped events %d, balance %d", n, f.balance(tolu))
	}
	if _, err := f.svc.UpdateSchedule(tolu.ctx, sch.ID, ScheduleChange{Status: ptr("active")}); !errors.Is(err, errScheduleEnded) {
		t.Fatalf("resume an ended schedule: %v", err)
	}
}

func TestPausedSchedulesSkipWhatTheyMissed(t *testing.T) {
	t.Parallel()
	f := newClockFixture(t)
	tolu := f.customer("Tolu", "tolu", 5_000_000)
	ada := f.customer("Ada", "ada", 0)
	sch, err := f.svc.CreateSchedule(tolu.ctx, NewSchedule{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(100_000),
		Frequency: "weekly", StartAt: f.now.Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.UpdateSchedule(tolu.ctx, sch.ID, ScheduleChange{Status: ptr("paused")}); err != nil {
		t.Fatal(err)
	}
	f.advance(15 * 24 * time.Hour)
	if err := f.svc.RunDue(t.Context()); err != nil {
		t.Fatal(err)
	}
	if f.balance(ada) != 0 {
		t.Fatal("a paused schedule ran")
	}
	resumed, err := f.svc.UpdateSchedule(tolu.ctx, sch.ID, ScheduleChange{Status: ptr("active")})
	if err != nil || resumed.RunCount != 0 || !resumed.NextRunAt.Equal(sch.NextRunAt.Add(21*24*time.Hour)) {
		t.Fatalf("resumed = %+v, %v", resumed, err)
	}
	if err := f.svc.CancelSchedule(tolu.ctx, sch.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := f.svc.GetSchedule(tolu.ctx, sch.ID); got.Status != "cancelled" || got.NextRunAt != nil {
		t.Fatalf("cancelled = %+v", got)
	}
	if _, err := f.svc.GetSchedule(ada.ctx, sch.ID); !errors.Is(err, ErrScheduleNotFound) {
		t.Fatalf("someone else's: %v", err)
	}
}
