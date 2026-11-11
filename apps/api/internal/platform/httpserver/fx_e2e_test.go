package httpserver

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/fx"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/limits"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/idempotency"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

// staticRates is a rates provider that always answers with the same dollar-based reading.
type staticRates struct{ snap fx.Snapshot }

func (s staticRates) Fetch(context.Context) (fx.Snapshot, error) { return s.snap, nil }

// fxStack is the whole API with FX wired in, and one signed-up customer.
type fxStack struct {
	h    http.Handler
	pool *pgxpool.Pool
	fx   *fx.Service
	key  ed25519.PrivateKey
	user api.AuthSession
}

func newFXStack(t *testing.T) *fxStack {
	t.Helper()
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	mail := &lastMail{}
	pool := testdb.New(t)
	idsvc, err := identity.NewService(identity.Config{
		Pool: pool, Mailer: mail, Logger: quiet,
		OTPKey:            []byte("0123456789abcdef0123456789abcdef"), // gitleaks:allow (test fixture)
		SigningKey:        []byte("fedcba9876543210fedcba9876543210"), // gitleaks:allow (test fixture)
		Hasher:            identity.NewHasher(identity.Argon2Params{MemoryKiB: 64, Time: 1, Threads: 1}, 2),
		OnCustomerCreated: accounts.OpenCurrentAccount,
	})
	if err != nil {
		t.Fatal(err)
	}
	acc, err := accounts.NewService(accounts.Config{Pool: pool, Customers: idsvc, Logger: quiet})
	if err != nil {
		t.Fatal(err)
	}
	lim, err := limits.NewService(limits.Config{Pool: pool, Customers: idsvc, StepUps: idsvc})
	if err != nil {
		t.Fatal(err)
	}
	snap := fx.Snapshot{Source: "open_er_api", PerUSD: map[money.Currency]fx.Rate{}}
	for c, v := range map[money.Currency]string{money.USD: "1", money.NGN: "1612.45", money.GBP: "0.7752", money.EUR: "0.9211"} {
		r, err := fx.ParseRate(v)
		if err != nil {
			t.Fatal(err)
		}
		snap.PerUSD[c] = r
	}
	fxsvc, err := fx.NewService(fx.Config{
		Pool: pool, Accounts: acc, Customers: idsvc, Limits: lim, Logger: quiet, Sources: []fx.RatesSource{staticRates{snap}},
	})
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewRouter(Options{
		Version: "e2e", Logger: quiet, Identity: identity.NewAPI(idsvc), Authenticator: idsvc, Signatures: idsvc,
		Idempotency: idempotency.NewStore(pool), Accounts: accounts.NewAPI(acc), Limits: limits.NewAPI(lim), FX: fx.NewAPI(fxsvc),
	})
	if err != nil {
		t.Fatal(err)
	}

	key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, ed25519.SeedSize))
	pub := base64.RawURLEncoding.EncodeToString(key.Public().(ed25519.PublicKey)) //nolint:forcetypeassert // always ed25519
	started := call[api.SignupStarted](t, h, http.MethodPost, "/v1/auth/signup", "", map[string]any{
		"first_name": "tolu", "last_name": "Adeyemi", "email": "tolu@example.com",
		"phone": "+2348031234501", "date_of_birth": "1996-04-12",
		"consent": map[string]string{"terms_version": "2026-10", "privacy_version": "2026-10", "accepted_at": "2026-11-01T10:00:00Z"},
	}, http.StatusCreated)
	verified := call[api.OtpVerified](t, h, http.MethodPost, "/v1/auth/otp/verify", "",
		map[string]string{"challenge_id": started.Otp.ChallengeId.String(), "code": mail.code()}, http.StatusOK)
	user := call[api.AuthSession](t, h, http.MethodPost, "/v1/auth/signup/complete", "", map[string]any{
		"signup_id": started.SignupId, "verification_token": verified.VerificationToken, "password": "Kitchen-Mango-River-7", // gitleaks:allow (test fixture)
		"device": map[string]any{"name": "tolu's phone", "platform": "ios", "public_key": pub},
	}, http.StatusCreated)
	return &fxStack{h: h, pool: pool, fx: fxsvc, key: key, user: user}
}

func TestRatesAndChartsAreServedFromTheHourlyReadings(t *testing.T) {
	t.Parallel()
	s := newFXStack(t)

	// Nothing has been read yet: an empty, still-indicative list, not an error.
	empty := call[api.FxRateList](t, s.h, http.MethodGet, "/v1/fx/rates", s.user.AccessToken, nil, http.StatusOK)
	if len(empty.Data) != 0 || !empty.Indicative {
		t.Fatalf("before the first reading: %+v", empty)
	}
	call[api.Problem](t, s.h, http.MethodGet, "/v1/fx/rates", "", nil, http.StatusUnauthorized)

	if err := s.fx.Ingest(t.Context()); err != nil {
		t.Fatal(err)
	}
	rates := call[api.FxRateList](t, s.h, http.MethodGet, "/v1/fx/rates", s.user.AccessToken, nil, http.StatusOK)
	if len(rates.Data) != 3 || !rates.Indicative {
		t.Fatalf("rates = %+v", rates)
	}
	usd := rates.Data[0]
	if usd.Pair != "USD-NGN" || usd.Base != "USD" || usd.Quote != "NGN" || usd.MidRate != "1612.45" ||
		usd.BuyRate != "1588.26325" || usd.SellRate != "1636.63675" || usd.SpreadBps != 150 || usd.Source != api.OpenErApi {
		t.Fatalf("USD-NGN = %+v", usd)
	}

	hist := call[api.FxRateHistory](t, s.h, http.MethodGet, "/v1/fx/rates/USD-NGN/history?range=1D", s.user.AccessToken, nil, http.StatusOK)
	if hist.Pair != "USD-NGN" || hist.Range != api.FxRateHistoryRangeN1D || len(hist.Points) != 1 || hist.Points[0].Rate != "1612.45" {
		t.Fatalf("history = %+v", hist)
	}
	// A pair the bank does not quote is a 404; a bad range never reaches the handler.
	call[api.Problem](t, s.h, http.MethodGet, "/v1/fx/rates/NGN-USD/history?range=1D", s.user.AccessToken, nil, http.StatusNotFound)
	call[api.Problem](t, s.h, http.MethodGet, fmt.Sprintf("/v1/fx/rates/USD-NGN/history?range=%s", "9Y"), s.user.AccessToken, nil, http.StatusBadRequest)
}
