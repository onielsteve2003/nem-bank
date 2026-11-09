package ratelimit

import (
	"sync"
	"testing"
	"time"
)

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func TestABurstUpToTheLimitPassesThenOnePerInterval(t *testing.T) {
	t.Parallel()
	c := &clock{t: time.Unix(1_800_000_000, 0)}
	l := New(c.Now)
	rule := Rule{Limit: 5, Window: time.Minute} // one every 12 s once the burst is spent

	for i := range 5 {
		if ok, _ := l.Allow("ip:1", rule); !ok {
			t.Fatalf("request %d of the burst refused", i+1)
		}
	}
	ok, wait := l.Allow("ip:1", rule)
	if ok || wait != 12*time.Second {
		t.Fatalf("6th = %v, retry after %v; want refused, 12s", ok, wait)
	}
	// A refused request is not counted: waiting the advertised time is enough.
	c.Advance(12 * time.Second)
	if ok, _ := l.Allow("ip:1", rule); !ok {
		t.Fatal("refused after waiting retryAfter")
	}
	if ok, _ := l.Allow("ip:1", rule); ok {
		t.Fatal("second request after one interval passed")
	}
	// Keys are independent.
	if ok, _ := l.Allow("ip:2", rule); !ok {
		t.Fatal("another key was limited")
	}
	// A full window of quiet refills the whole burst.
	c.Advance(time.Minute)
	for i := range 5 {
		if ok, _ := l.Allow("ip:1", rule); !ok {
			t.Fatalf("refilled burst request %d refused", i+1)
		}
	}
}

func TestStaleKeysAreSweptAndAZeroRuleAllowsEverything(t *testing.T) {
	t.Parallel()
	c := &clock{t: time.Unix(1_800_000_000, 0)}
	l := New(c.Now)
	rule := Rule{Limit: 10, Window: time.Second}
	for _, k := range []string{"a", "b", "c"} {
		l.Allow(k, rule)
	}
	if l.Len() != 3 {
		t.Fatalf("len = %d", l.Len())
	}
	c.Advance(2 * time.Minute)
	l.Allow("d", rule)
	if l.Len() != 1 {
		t.Fatalf("after sweep len = %d, want 1", l.Len())
	}
	for range 100 {
		if ok, _ := l.Allow("x", Rule{}); !ok {
			t.Fatal("zero rule refused")
		}
	}
}

func TestConcurrentCallersNeverExceedTheBurst(t *testing.T) {
	t.Parallel()
	c := &clock{t: time.Unix(1_800_000_000, 0)}
	l := New(c.Now)
	rule := Rule{Limit: 20, Window: time.Hour}
	var mu sync.Mutex
	passed := 0
	var wg sync.WaitGroup
	for range 200 {
		wg.Go(func() {
			if ok, _ := l.Allow("user:1", rule); ok {
				mu.Lock()
				passed++
				mu.Unlock()
			}
		})
	}
	wg.Wait()
	if passed != 20 {
		t.Fatalf("passed = %d, want 20", passed)
	}
}
