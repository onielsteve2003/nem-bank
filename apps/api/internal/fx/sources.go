package fx

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

// Snapshot is one provider's reading: how many units of each currency one US dollar buys.
// Every provider quotes against the dollar, and the naira pairs are worked out from that.
type Snapshot struct {
	// Source is the contract's FxRateSource: "open_er_api" or "frankfurter".
	Source string
	// PerUSD holds USD (always 1), GBP and EUR, and NGN when the provider has it.
	PerUSD map[money.Currency]Rate
}

// RatesSource reads indicative rates from a free provider (architecture §4). Sources are
// tried in order; the first that answers sanely wins.
type RatesSource interface {
	Fetch(ctx context.Context) (Snapshot, error)
}

// Endpoints of the free providers (FX-5). Both are indicative, hourly-grade data.
const (
	OpenERAPIURL   = "https://open.er-api.com/v6/latest/USD"
	FrankfurterURL = "https://api.frankfurter.dev/v1/latest?base=USD&symbols=GBP,EUR"
)

// maxBody bounds a provider's reply; the real ones are a few kilobytes.
const maxBody = 1 << 20

// HTTPSource reads a provider's JSON over HTTP. The two providers differ only in URL and
// in which currencies they list, so one type serves both.
type HTTPSource struct {
	name   string
	url    string
	client *http.Client
	// needNGN is true for a provider that must list the naira (open.er-api.com). The
	// European Central Bank data behind Frankfurter has no naira.
	needNGN bool
}

// NewOpenERAPI reads open.er-api.com, which lists the naira. An empty url means the public
// endpoint; tests point it at a fake server.
func NewOpenERAPI(url string, client *http.Client) *HTTPSource {
	if url == "" {
		url = OpenERAPIURL
	}
	return &HTTPSource{name: "open_er_api", url: url, client: orDefault(client), needNGN: true}
}

// NewFrankfurter reads Frankfurter (ECB data): the majors only, no naira.
func NewFrankfurter(url string, client *http.Client) *HTTPSource {
	if url == "" {
		url = FrankfurterURL
	}
	return &HTTPSource{name: "frankfurter", url: url, client: orDefault(client)}
}

func orDefault(c *http.Client) *http.Client {
	if c == nil {
		return &http.Client{Timeout: 10 * time.Second}
	}
	return c
}

// Fetch implements RatesSource.
func (h *HTTPSource) Fetch(ctx context.Context) (Snapshot, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.url, nil)
	if err != nil {
		return Snapshot{}, fmt.Errorf("%s: build request: %w", h.name, err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "nem-bank-api")
	resp, err := h.client.Do(req) //nolint:gosec // the URL is operator configuration, not request input
	if err != nil {
		return Snapshot{}, fmt.Errorf("%s: %w", h.name, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return Snapshot{}, fmt.Errorf("%s: status %d", h.name, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return Snapshot{}, fmt.Errorf("%s: read: %w", h.name, err)
	}
	return h.parse(body)
}

// reply covers both providers' shapes. Numbers stay json.Number so they are read as the
// decimal text the provider sent, never through a float.
type reply struct {
	Result string                 `json:"result"` // open.er-api.com only
	Rates  map[string]json.Number `json:"rates"`
}

func (h *HTTPSource) parse(body []byte) (Snapshot, error) {
	var r reply
	if err := json.Unmarshal(body, &r); err != nil {
		return Snapshot{}, fmt.Errorf("%s: decode: %w", h.name, err)
	}
	if h.needNGN && r.Result != "success" {
		return Snapshot{}, fmt.Errorf("%s: result %q", h.name, r.Result)
	}
	snap := Snapshot{Source: h.name, PerUSD: map[money.Currency]Rate{money.USD: rateScale}}
	for _, c := range []money.Currency{money.GBP, money.EUR, money.NGN} {
		raw, ok := r.Rates[string(c)]
		if !ok {
			if c == money.NGN && !h.needNGN {
				continue // the service carries the naira over from the last good reading
			}
			return Snapshot{}, fmt.Errorf("%s: no %s rate", h.name, c)
		}
		v, err := roundRate(raw.String())
		if err != nil {
			return Snapshot{}, fmt.Errorf("%s: %s: %w", h.name, c, err)
		}
		snap.PerUSD[c] = v
	}
	return snap, nil
}
