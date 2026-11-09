// Package ratelimit is an in-memory GCRA (generic cell rate algorithm) limiter.
//
// GCRA is a token bucket stored as one timestamp per key: the "theoretical arrival time"
// of the next request. A rule allowing N per window lets a burst of N through, then one
// every window/N. One timestamp per key keeps memory small and the check O(1).
//
// State is per process. The API runs as one instance (Render free), so that is exact
// today; a restart forgets the counts, which only ever errs towards letting requests
// through. Several instances would need a shared store (Postgres or Redis) behind the
// same Allow call.
package ratelimit

import (
	"sync"
	"time"
)

// Rule allows Limit requests per Window, in a burst or spread out.
type Rule struct {
	Limit  int
	Window time.Duration
}

// interval is the steady-state gap between requests.
func (r Rule) interval() time.Duration { return r.Window / time.Duration(r.Limit) }

// Limiter tracks keys across any number of rules. The zero value is not usable; use New.
type Limiter struct {
	now func() time.Time

	mu        sync.Mutex
	tat       map[string]time.Time
	lastSweep time.Time
}

// New returns a limiter on the given clock (nil means time.Now).
func New(now func() time.Time) *Limiter {
	if now == nil {
		now = time.Now
	}
	return &Limiter{now: now, tat: map[string]time.Time{}, lastSweep: now()}
}

// sweepEvery bounds how often stale keys are dropped. A key whose arrival time is in the
// past is the same as a key never seen, so dropping it changes no decision.
const sweepEvery = time.Minute

// Allow records a request for key under rule. When the request is over the limit it is
// not counted, and retryAfter says when one would pass. A rule with Limit 0 or less
// allows everything.
func (l *Limiter) Allow(key string, rule Rule) (ok bool, retryAfter time.Duration) {
	if rule.Limit <= 0 || rule.Window <= 0 {
		return true, 0
	}
	now := l.now()
	interval := rule.interval()
	// Up to Limit requests may arrive at once: the bucket's depth.
	burst := rule.Window - interval

	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.lastSweep) >= sweepEvery {
		for k, t := range l.tat {
			if !t.After(now) {
				delete(l.tat, k)
			}
		}
		l.lastSweep = now
	}

	tat := l.tat[key]
	if tat.Before(now) {
		tat = now
	}
	if wait := tat.Sub(now) - burst; wait > 0 {
		return false, wait
	}
	l.tat[key] = tat.Add(interval)
	return true, 0
}

// Len is the number of keys held, for tests and metrics.
func (l *Limiter) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.tat)
}
