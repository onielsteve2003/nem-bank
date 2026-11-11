package fx

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts/accountsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/limits"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

// clock is a settable time source shared with the service.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// fakeSource answers with a fixed snapshot or error.
type fakeSource struct {
	mu    sync.Mutex
	snap  Snapshot
	err   error
	calls int
}

func (f *fakeSource) Fetch(context.Context) (Snapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return f.snap, f.err
}

func (f *fakeSource) set(snap Snapshot, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.snap, f.err = snap, err
}

func snapshot(source, ngn, gbp, eur string) Snapshot {
	s := Snapshot{Source: source, PerUSD: map[money.Currency]Rate{money.USD: rateScale}}
	for c, v := range map[money.Currency]string{money.NGN: ngn, money.GBP: gbp, money.EUR: eur} {
		if v == "" {
			continue
		}
		r, err := ParseRate(v)
		if err != nil {
			panic(err)
		}
		s.PerUSD[c] = r
	}
	return s
}

// noAccounts and friends satisfy Config for tests that never touch an account.
type noAccounts struct{}

func (noAccounts) Owned(context.Context, uuid.UUID, uuid.UUID) (accountsdb.GetCustomerAccountRow, error) {
	return accountsdb.GetCustomerAccountRow{}, errors.New("no accounts in this test")
}

type tier2 struct{}

func (tier2) CustomerProfile(context.Context, uuid.UUID) (identity.CustomerProfile, error) {
	return identity.CustomerProfile{KycTier: 2}, nil
}

type rules struct{}

func (rules) Rules() limits.Rules { return limits.DefaultRules() }

func newRatesService(t *testing.T, pool *pgxpool.Pool, clk *clock, sources ...RatesSource) *Service {
	t.Helper()
	svc, err := NewService(Config{
		Pool: pool, Accounts: noAccounts{}, Customers: tier2{}, Limits: rules{}, Sources: sources,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: clk.Now,
	})
	if err != nil {
		t.Fatal(err)
	}
	return svc
}

func newClock() *clock {
	return &clock{t: time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC)}
}

func rateOf(t *testing.T, views []RateView, pair string) RateView {
	t.Helper()
	for _, v := range views {
		if v.Pair == pair {
			return v
		}
	}
	t.Fatalf("no %s in %+v", pair, views)
	return RateView{}
}

func TestIngestStoresEveryPairWithTheSpreadApplied(t *testing.T) {
	t.Parallel()
	clk := newClock()
	src := &fakeSource{snap: snapshot("open_er_api", "1612.45", "0.7752", "0.9211")}
	svc := newRatesService(t, testdb.New(t), clk, src)
	ctx := t.Context()

	if v, err := svc.Rates(ctx); err != nil || len(v) != 0 {
		t.Fatalf("before the first reading: %+v, %v", v, err)
	}
	if err := svc.Ingest(ctx); err != nil {
		t.Fatal(err)
	}
	views, err := svc.Rates(ctx)
	if err != nil || len(views) != 3 || views[0].Pair != "USD-NGN" || views[1].Pair != "GBP-NGN" || views[2].Pair != "EUR-NGN" {
		t.Fatalf("rates = %+v, %v", views, err)
	}
	usd := rateOf(t, views, "USD-NGN")
	if usd.Mid.String() != "1612.45" || usd.Buy.String() != "1588.26325" || usd.Sell.String() != "1636.63675" ||
		usd.SpreadBPS != 150 || usd.Source != "open_er_api" || !usd.AsOf.Equal(clk.Now()) || usd.Base != money.USD || usd.Quote != money.NGN {
		t.Fatalf("USD-NGN = %+v", usd)
	}
	if gbp := rateOf(t, views, "GBP-NGN"); gbp.Mid.String() != "2080.04385965" {
		t.Fatalf("GBP-NGN mid = %s", gbp.Mid)
	}
	if eur := rateOf(t, views, "EUR-NGN"); eur.Mid.String() != "1750.56997069" {
		t.Fatalf("EUR-NGN mid = %s", eur.Mid)
	}
}

func TestStoredRatesAgeIntoCacheAndNeverExceedTheirSpreadOrder(t *testing.T) {
	t.Parallel()
	clk := newClock()
	svc := newRatesService(t, testdb.New(t), clk, &fakeSource{snap: snapshot("frankfurter", "1500", "0.8", "0.9")})
	ctx := t.Context()
	if err := svc.Ingest(ctx); err != nil {
		t.Fatal(err)
	}
	clk.advance(90 * time.Minute)
	if v, _ := svc.Rates(ctx); v[0].Source != "frankfurter" {
		t.Fatalf("90 minutes old should still be live, got %q", v[0].Source)
	}
	clk.advance(40 * time.Minute) // 2h10m: one hourly run was missed
	views, _ := svc.Rates(ctx)
	for _, v := range views {
		if v.Source != "cache" || v.Buy >= v.Mid || v.Mid >= v.Sell {
			t.Fatalf("%s = %+v", v.Pair, v)
		}
	}
}

func TestIngestFallsBackToTheNextSource(t *testing.T) {
	t.Parallel()
	clk := newClock()
	primary := &fakeSource{err: errors.New("503 from the provider")}
	fallback := &fakeSource{snap: snapshot("frankfurter", "1610", "0.78", "0.92")}
	svc := newRatesService(t, testdb.New(t), clk, primary, fallback)
	ctx := t.Context()

	// Frankfurter has no naira, and nothing is stored yet to carry: refused, not guessed.
	fallback.set(snapshot("frankfurter", "", "0.78", "0.92"), nil)
	err := svc.Ingest(ctx)
	if err == nil || !errors.Is(err, errNoAnchor) {
		t.Fatalf("no anchor: %v", err)
	}
	if v, _ := svc.Rates(ctx); len(v) != 0 {
		t.Fatalf("a refused reading was stored: %+v", v)
	}

	// With the naira in the fallback's own reading it is used as is.
	fallback.set(snapshot("frankfurter", "1610", "0.78", "0.92"), nil)
	if err := svc.Ingest(ctx); err != nil {
		t.Fatal(err)
	}
	if v, _ := svc.Rates(ctx); v[0].Source != "frankfurter" || v[0].Mid.String() != "1610" {
		t.Fatalf("after fallback: %+v", v)
	}

	// The next hour the primary is back: it wins again.
	clk.advance(time.Hour)
	primary.set(snapshot("open_er_api", "1620", "0.78", "0.92"), nil)
	if err := svc.Ingest(ctx); err != nil {
		t.Fatal(err)
	}
	if v, _ := svc.Rates(ctx); v[0].Source != "open_er_api" || v[0].Mid.String() != "1620" {
		t.Fatalf("after recovery: %+v", v)
	}
}

func TestAProviderWithoutNairaCarriesTheLastNairaPrice(t *testing.T) {
	t.Parallel()
	clk := newClock()
	primary := &fakeSource{snap: snapshot("open_er_api", "1600", "0.8", "0.9")}
	secondary := &fakeSource{snap: snapshot("frankfurter", "", "0.8", "0.9")}
	svc := newRatesService(t, testdb.New(t), clk, primary, secondary)
	ctx := t.Context()
	if err := svc.Ingest(ctx); err != nil {
		t.Fatal(err)
	}
	clk.advance(time.Hour)
	primary.set(Snapshot{}, errors.New("timeout"))
	secondary.set(snapshot("frankfurter", "", "0.8", "0.9"), nil)
	if err := svc.Ingest(ctx); err != nil {
		t.Fatal(err)
	}
	views, _ := svc.Rates(ctx)
	if usd := rateOf(t, views, "USD-NGN"); usd.Source != "frankfurter" || usd.Mid.String() != "1600" {
		t.Fatalf("usd = %+v", usd)
	}
	if gbp := rateOf(t, views, "GBP-NGN"); gbp.Mid.String() != "2000" { // 1600 / 0.8
		t.Fatalf("gbp = %+v", gbp)
	}

	// Past 48 hours the carried naira price is too old to stand in.
	clk.advance(49 * time.Hour)
	if err := svc.Ingest(ctx); !errors.Is(err, errNoAnchor) {
		t.Fatalf("stale anchor: %v", err)
	}
}

func TestIngestRefusesAReadingThatJumpsTooFar(t *testing.T) {
	t.Parallel()
	clk := newClock()
	src := &fakeSource{snap: snapshot("open_er_api", "1600", "0.8", "0.9")}
	svc := newRatesService(t, testdb.New(t), clk, src)
	ctx := t.Context()
	if err := svc.Ingest(ctx); err != nil {
		t.Fatal(err)
	}

	// A provider glitch: the naira "doubles" within the hour.
	clk.advance(time.Hour)
	src.set(snapshot("open_er_api", "3200", "0.8", "0.9"), nil)
	if err := svc.Ingest(ctx); err == nil || !strings.Contains(err.Error(), "reading refused") {
		t.Fatalf("a 100%% jump: %v", err)
	}
	if v, _ := svc.Rates(ctx); v[0].Mid.String() != "1600" {
		t.Fatalf("the bad reading was stored: %+v", v)
	}

	// A move inside the limit is fine.
	src.set(snapshot("open_er_api", "1700", "0.8", "0.9"), nil)
	if err := svc.Ingest(ctx); err != nil {
		t.Fatal(err)
	}

	// If the market truly moved, the guard lapses once the last reading is old news.
	clk.advance(7 * time.Hour)
	src.set(snapshot("open_er_api", "3200", "0.8", "0.9"), nil)
	if err := svc.Ingest(ctx); err != nil {
		t.Fatalf("after the window: %v", err)
	}
}

func TestIngestFailsLoudlyWhenEverySourceFails(t *testing.T) {
	t.Parallel()
	svc := newRatesService(t, testdb.New(t), newClock(),
		&fakeSource{err: errors.New("boom one")}, &fakeSource{err: errors.New("boom two")})
	err := svc.Ingest(t.Context())
	if err == nil || !strings.Contains(err.Error(), "boom one") || !strings.Contains(err.Error(), "boom two") {
		t.Fatalf("err = %v", err)
	}
	if err := newRatesService(t, testdb.New(t), newClock()).Ingest(t.Context()); err == nil {
		t.Fatal("no sources should be an error, not a silent success")
	}
}

func TestHistoryBucketsReadingsForEachRange(t *testing.T) {
	t.Parallel()
	clk := newClock() // 2026-11-10 09:00 UTC
	src := &fakeSource{}
	svc := newRatesService(t, testdb.New(t), clk, src)
	ctx := t.Context()

	// 40 hourly readings, creeping up 0.1% an hour so no jump is refused.
	ngn := 1600.0
	for i := 0; i < 40; i++ {
		src.set(snapshot("open_er_api", rateString(ngn), "0.8", "0.9"), nil)
		if err := svc.Ingest(ctx); err != nil {
			t.Fatalf("reading %d: %v", i, err)
		}
		ngn *= 1.001
		clk.advance(time.Hour)
	}
	day, err := svc.History(ctx, "USD-NGN", "1D")
	if err != nil {
		t.Fatal(err)
	}
	if len(day) < 23 || len(day) > 25 {
		t.Fatalf("1D has %d points, want about 24", len(day))
	}
	for i := 1; i < len(day); i++ {
		if !day[i].At.After(day[i-1].At) || day[i].Rate <= day[i-1].Rate {
			t.Fatalf("points not ascending at %d: %+v %+v", i, day[i-1], day[i])
		}
	}
	week, _ := svc.History(ctx, "USD-NGN", "1W")
	if len(week) < 6 || len(week) > 8 { // 40 hours in 6-hour buckets
		t.Fatalf("1W has %d points, want 7 or so", len(week))
	}
	for _, p := range week {
		if p.At.Unix()%(6*3600) != 0 {
			t.Fatalf("bucket %s is not on the 6-hour grid", p.At)
		}
	}
	if month, _ := svc.History(ctx, "USD-NGN", "1M"); len(month) != 3 { // Nov 8, 9, 10 UTC days
		t.Fatalf("1M has %d points", len(month))
	}
	if year, _ := svc.History(ctx, "GBP-NGN", "1Y"); len(year) < 1 || len(year) > 2 {
		t.Fatalf("1Y has %d points", len(year))
	}

	for _, bad := range [][2]string{{"NGN-USD", "1D"}, {"USD-NGN", "5Y"}, {"XXX-NGN", "1D"}} {
		if _, err := svc.History(ctx, bad[0], bad[1]); !errors.Is(err, ErrPairNotFound) {
			t.Errorf("History(%v) = %v", bad, err)
		}
	}
}

func rateString(f float64) string {
	r := Rate(f * rateScale)
	return r.String()
}

func TestPruneKeepsTheChartWindow(t *testing.T) {
	t.Parallel()
	clk := newClock()
	pool := testdb.New(t)
	src := &fakeSource{snap: snapshot("open_er_api", "1600", "0.8", "0.9")}
	svc := newRatesService(t, pool, clk, src)
	ctx := t.Context()
	if err := svc.Ingest(ctx); err != nil {
		t.Fatal(err)
	}
	clk.advance(401 * 24 * time.Hour)
	src.set(snapshot("open_er_api", "1700", "0.8", "0.9"), nil)
	if err := svc.Ingest(ctx); err != nil {
		t.Fatal(err)
	}
	if err := svc.Prune(ctx); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM fx_rates`).Scan(&n); err != nil || n != 3 {
		t.Fatalf("rows after prune = %d, %v", n, err)
	}
}

func TestHTTPSourcesParseTheProvidersReplies(t *testing.T) {
	t.Parallel()
	serve := func(status int, body string) *httptest.Server {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("User-Agent") == "" || r.Header.Get("Cookie") != "" {
				http.Error(w, "unexpected headers", http.StatusBadRequest)
				return
			}
			w.WriteHeader(status)
			_, _ = io.WriteString(w, body)
		}))
		t.Cleanup(srv.Close)
		return srv
	}
	ctx := t.Context()

	er := serve(200, `{"result":"success","base_code":"USD","rates":{"USD":1,"NGN":1612.45,"GBP":0.77521668123,"EUR":0.9211,"JPY":150.1}}`)
	snap, err := NewOpenERAPI(er.URL, nil).Fetch(ctx)
	if err != nil || snap.Source != "open_er_api" || snap.PerUSD[money.NGN].String() != "1612.45" ||
		snap.PerUSD[money.GBP].String() != "0.77521668" || snap.PerUSD[money.EUR].String() != "0.9211" || snap.PerUSD[money.USD] != rateScale {
		t.Fatalf("open.er-api = %+v, %v", snap, err)
	}

	fr := serve(200, `{"amount":1,"base":"USD","date":"2026-11-10","rates":{"EUR":0.9211,"GBP":0.7752}}`)
	snap, err = NewFrankfurter(fr.URL, nil).Fetch(ctx)
	if _, hasNGN := snap.PerUSD[money.NGN]; err != nil || hasNGN || snap.Source != "frankfurter" || snap.PerUSD[money.GBP].String() != "0.7752" {
		t.Fatalf("frankfurter = %+v, %v", snap, err)
	}

	for name, src := range map[string]*HTTPSource{
		"error result":      NewOpenERAPI(serve(200, `{"result":"error","error-type":"quota-reached"}`).URL, nil),
		"missing naira":     NewOpenERAPI(serve(200, `{"result":"success","rates":{"GBP":0.8,"EUR":0.9}}`).URL, nil),
		"missing pound":     NewFrankfurter(serve(200, `{"rates":{"EUR":0.9}}`).URL, nil),
		"zero rate":         NewFrankfurter(serve(200, `{"rates":{"EUR":0.9,"GBP":0}}`).URL, nil),
		"not json":          NewFrankfurter(serve(200, `<html>maintenance</html>`).URL, nil),
		"server error":      NewFrankfurter(serve(500, `{}`).URL, nil),
		"string not number": NewFrankfurter(serve(200, `{"rates":{"EUR":"x","GBP":0.8}}`).URL, nil),
	} {
		if snap, err := src.Fetch(ctx); err == nil {
			t.Errorf("%s: accepted %+v", name, snap)
		}
	}
}
