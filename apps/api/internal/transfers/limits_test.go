package transfers

import (
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

func wantProblem(t *testing.T, err error, code, detail string) {
	t.Helper()
	var p *problem.Error
	if !errors.As(err, &p) || p.Code != code || (detail != "" && p.Detail != detail) {
		t.Fatalf("err = %v (%+v), want %s %q", err, p, code, detail)
	}
}

func (f *fixture) tier(c customer, tier int) {
	f.profs.mu.Lock()
	prof := f.profs.m[c.id]
	f.profs.mu.Unlock()
	prof.KycTier = tier
	f.profs.set(c.id, prof)
}

func (f *fixture) count(query string, args ...any) int {
	f.t.Helper()
	var n int
	if err := f.pool.QueryRow(f.t.Context(), query, args...).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

func TestTheDailyLimitIsCountedAndEnforced(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu := f.customer("Tolu", "tolu", 10_000_000)
	ada := f.customer("Ada", "ada", 0)
	f.tier(tolu, 1) // ₦50,000 a day

	if _, err := f.svc.Create(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(3_000_000)}); err != nil {
		t.Fatal(err)
	}
	_, err := f.svc.Create(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toBank("058", "0123456789"), Amount: ngn(2_500_000)})
	wantProblem(t, err, "limit_exceeded", "You can send ₦20,000.00 more today.")
	if n := f.count(`SELECT count(*) FROM transfers`); n != 1 || f.balance(tolu) != 7_000_000 {
		t.Fatalf("refused transfer left %d transfers, balance %d", n, f.balance(tolu))
	}

	q, err := f.svc.Quote(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(100)})
	if err != nil {
		t.Fatal(err)
	}
	if st := q.Limits; st.Tier != 1 || st.DailyMinor != 5_000_000 || st.UsedMinor != 3_000_000 || st.RemainingMinor != 2_000_000 || st.SelfSet || st.CoolOffActive {
		t.Fatalf("status = %+v", st)
	}
	// Exactly what is left still goes.
	if _, err := f.svc.Create(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(2_000_000)}); err != nil {
		t.Fatal(err)
	}
}

func TestRacingTransfersCannotBothTakeTheLastOfTheDay(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu := f.customer("Tolu", "tolu", 50_000_000)
	ada := f.customer("Ada", "ada", 0)
	f.tier(tolu, 1)

	var wg sync.WaitGroup
	var mu sync.Mutex
	sent, refused := 0, 0
	for range 10 {
		wg.Go(func() {
			_, err := f.svc.Create(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(1_000_000)})
			mu.Lock()
			defer mu.Unlock()
			var p *problem.Error
			switch {
			case err == nil:
				sent++
			case errors.As(err, &p) && p.Code == "limit_exceeded":
				refused++
			default:
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if sent != 5 || refused != 5 || f.balance(tolu) != 45_000_000 {
		t.Fatalf("sent %d, refused %d, balance %d", sent, refused, f.balance(tolu))
	}
}

func TestOwnLimitsAndCoolOffBind(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu := f.customer("Tolu", "tolu", 10_000_000)
	ada := f.customer("Ada", "ada", 0)
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO self_limits (user_id, daily_minor, single_minor) VALUES ($1, 3_000_000, 1_000_000)`, tolu.id); err != nil {
		t.Fatal(err)
	}

	_, err := f.svc.Create(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(1_000_001)})
	wantProblem(t, err, "limit_exceeded", "Your own limit is ₦10,000.00 per transfer.")
	q, err := f.svc.Quote(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(100)})
	if err != nil || q.Limits.DailyMinor != 3_000_000 || !q.Limits.SelfSet {
		t.Fatalf("own limit status = %+v, %v", q.Limits, err)
	}

	// A new device caps the day lower still, and the quote says so.
	f.profs.mu.Lock()
	f.profs.coolOff = identity.CoolOff{Active: true, DailyLimitMinor: 500_000, Reason: "new_device"}
	f.profs.mu.Unlock()
	q, err = f.svc.Quote(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(100)})
	if err != nil || q.Limits.DailyMinor != 500_000 || q.Limits.SelfSet || !q.Limits.CoolOffActive || (q.CoolingOff == nil || q.CoolingOff.Reason != "new_device") {
		t.Fatalf("cool-off status = %+v, %v", q.Limits, err)
	}
	_, err = f.svc.Create(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(600_000)})
	wantProblem(t, err, "limit_exceeded", "You can send ₦5,000.00 more today.")
}

func TestQuotesPriceLikeTheTransfer(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu := f.customer("Tolu", "tolu", 10_000_000)
	ada := f.customer("Ada", "ada", 0)

	for _, tc := range []struct {
		name        string
		amount, fee int64
		rail        string
		internal    bool
		wantFees    int
	}{
		{"nem to nem is free", 6_000_000, 0, "internal", true, 0},
		{"₦5,000 band", 500_000, 1_000, "interbank", false, 1},
		{"₦50,000 band", 500_001, 2_500, "interbank", false, 1},
		{"above ₦50,000", 5_000_001, 5_000, "interbank", false, 1},
	} {
		dest := toBank("058", "0123456789")
		if tc.internal {
			dest = toNem(ada.number)
		}
		q, err := f.svc.Quote(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: dest, Amount: ngn(tc.amount)})
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if q.Fee.Amount() != tc.fee || q.Total.Amount() != tc.amount+tc.fee || q.Rail != tc.rail || len(q.Fees) != tc.wantFees ||
			!q.Expires.After(time.Now()) || q.Limits.DailyMinor != 20_000_000 {
			t.Errorf("%s: quote = %+v", tc.name, q)
		}
	}
	if n := f.count(`SELECT count(*) FROM daily_limit_usage`); n != 0 {
		t.Fatalf("a quote reserved limit: %d rows", n)
	}
}

func TestTheReceiversBalanceCapHolds(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu := f.customer("Tolu", "tolu", 10_000_000)
	ada := f.customer("Ada", "ada", 29_000_000)
	f.tier(ada, 1) // holds up to ₦300,000

	_, err := f.svc.Create(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(2_000_000)})
	wantProblem(t, err, "max_balance_exceeded", "")
	if f.balance(tolu) != 10_000_000 || f.balance(ada) != 29_000_000 || f.count(`SELECT count(*) FROM daily_limit_usage WHERE used_minor > 0`) != 0 {
		t.Fatalf("refused credit moved money: %d, %d", f.balance(tolu), f.balance(ada))
	}
	// ₦10,050 lands as ₦10,000 after the levy: exactly at the cap.
	if _, err := f.svc.Create(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(1_005_000)}); err != nil {
		t.Fatal(err)
	}
	if f.balance(ada) != 30_000_000 {
		t.Fatalf("ada = %d", f.balance(ada))
	}
}
