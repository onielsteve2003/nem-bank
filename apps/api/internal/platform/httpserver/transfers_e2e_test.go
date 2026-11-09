package httpserver

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/limits"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/idempotency"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers/partners"
)

// TestASignedInternalTransferIsSentOnce sends money through the whole stack: sign-up
// opens both accounts, the request is device-signed, and a double tap with the same
// Idempotency-Key replays the first answer instead of debiting twice (TRF-5).
func TestASignedInternalTransferIsSentOnce(t *testing.T) {
	t.Parallel()
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	mail := &lastMail{}
	pool := testdb.New(t)
	var tr *transfers.Service
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
	acc, err := accounts.NewService(accounts.Config{Pool: pool, Customers: idsvc, Logger: quiet,
		Timelines: func(ctx context.Context, id uuid.UUID) ([]api.TimelineEvent, error) { return tr.Timeline(ctx, id) }})
	if err != nil {
		t.Fatal(err)
	}
	// The sandbox rail calls back into this same router over real HTTP, as it does in
	// production over loopback.
	var h http.Handler
	self := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { h.ServeHTTP(w, r) }))
	t.Cleanup(self.Close)
	secret := []byte("e2e-sandbox-nip-secret-0123456789") // gitleaks:allow (test fixture)
	sandbox, err := partners.NewSandboxNIP(partners.SandboxConfig{
		Pool: pool, CallbackURL: self.URL + "/v1/partner-webhooks/sandbox_nip", Secret: secret, Logger: quiet,
	})
	if err != nil {
		t.Fatal(err)
	}
	lim, err := limits.NewService(limits.Config{Pool: pool, Customers: idsvc, StepUps: idsvc})
	if err != nil {
		t.Fatal(err)
	}
	if tr, err = transfers.NewService(transfers.Config{Pool: pool, Accounts: acc, Customers: idsvc, Logger: quiet, Limits: lim,
		Sandbox: sandbox, WebhookSecrets: map[string][]byte{"sandbox_nip": secret}}); err != nil {
		t.Fatal(err)
	}
	h, err = NewRouter(Options{
		Version: "e2e", Logger: quiet, Identity: identity.NewAPI(idsvc), Authenticator: idsvc, Signatures: idsvc,
		Idempotency: idempotency.NewStore(pool), Accounts: accounts.NewAPI(acc), Transfers: transfers.NewAPI(tr),
		Limits: limits.NewAPI(lim), PartnerCallbacks: tr,
	})
	if err != nil {
		t.Fatal(err)
	}

	signUp := func(first string, n int, key ed25519.PrivateKey) api.AuthSession {
		t.Helper()
		pub := base64.RawURLEncoding.EncodeToString(key.Public().(ed25519.PublicKey)) //nolint:forcetypeassert // always ed25519
		started := call[api.SignupStarted](t, h, http.MethodPost, "/v1/auth/signup", "", map[string]any{
			"first_name": first, "last_name": "Adeyemi", "email": fmt.Sprintf("%s@example.com", first),
			"phone": fmt.Sprintf("+23480312345%02d", n), "date_of_birth": "1996-04-12",
			"consent": map[string]string{"terms_version": "2026-10", "privacy_version": "2026-10", "accepted_at": "2026-11-01T10:00:00Z"},
		}, http.StatusCreated)
		verified := call[api.OtpVerified](t, h, http.MethodPost, "/v1/auth/otp/verify", "",
			map[string]string{"challenge_id": started.Otp.ChallengeId.String(), "code": mail.code()}, http.StatusOK)
		return call[api.AuthSession](t, h, http.MethodPost, "/v1/auth/signup/complete", "", map[string]any{
			"signup_id": started.SignupId, "verification_token": verified.VerificationToken, "password": "Kitchen-Mango-River-7", // gitleaks:allow (test fixture)
			"device": map[string]any{"name": first + "'s phone", "platform": "ios", "public_key": pub},
		}, http.StatusCreated)
	}
	toluKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, ed25519.SeedSize))
	tolu := signUp("tolu", 1, toluKey)
	ada := signUp("ada", 2, ed25519.NewKeyFromSeed(bytes.Repeat([]byte{9}, ed25519.SeedSize)))
	toluAcc := call[api.AccountList](t, h, http.MethodGet, "/v1/accounts", tolu.AccessToken, nil, http.StatusOK).Data[0]
	adaAcc := call[api.AccountList](t, h, http.MethodGet, "/v1/accounts", ada.AccessToken, nil, http.StatusOK).Data[0]
	adaNuban, err := adaAcc.ReceivingDetails.AsNubanDetails()
	if err != nil {
		t.Fatal(err)
	}
	// Demo funding arrives with Demo Controls (T31); post it straight to the ledger here.
	if err := pgx.BeginFunc(t.Context(), pool, func(tx pgx.Tx) error {
		src, err := ledger.SystemAccount(t.Context(), tx, ledger.KindDemoFunding, "NGN")
		if err != nil {
			return err
		}
		amt := money.New(1_000_000, money.NGN)
		_, err = ledger.Post(t.Context(), tx, ledger.Entry{Kind: "demo_funding", Reference: "seed",
			Legs: []ledger.Leg{ledger.Debit(src.ID, amt), ledger.Credit(toluAcc.Id, amt)}})
		return err
	}); err != nil {
		t.Fatal(err)
	}

	body := `{"source_account_id":"` + toluAcc.Id.String() + `","destination":{"kind":"nem","account_number":"` +
		adaNuban.AccountNumber + `"},"amount":{"amount_minor":"250000","currency":"NGN"},"narration":"Lunch"}`
	key := uuid.NewString()
	first := signedPostKey(t, h, toluKey, tolu.Device.Id, tolu.AccessToken, "/v1/transfers", body, "nonce-trf-000001", key)
	if first.Code != http.StatusCreated {
		t.Fatalf("transfer = %d: %s", first.Code, first.Body)
	}
	// The double tap: same key and body, a fresh signature (each tap signs anew).
	second := signedPostKey(t, h, toluKey, tolu.Device.Id, tolu.AccessToken, "/v1/transfers", body, "nonce-trf-000002", key)
	if second.Code != http.StatusCreated || second.Header().Get("Idempotent-Replayed") != "true" || second.Body.String() != first.Body.String() {
		t.Fatalf("double tap = %d %q: %s", second.Code, second.Header().Get("Idempotent-Replayed"), second.Body)
	}

	sent := decode[api.Transfer](t, first.Body.Bytes())
	if sent.Status != api.TransferStatusCompleted || sent.Amount.AmountMinor != "250000" {
		t.Fatalf("sent = %+v", sent)
	}
	got := call[api.Transfer](t, h, http.MethodGet, "/v1/transfers/"+sent.Id.String(), tolu.AccessToken, nil, http.StatusOK)
	if len(got.Timeline) != 3 || got.Timeline[2].Label != "Sent instantly" {
		t.Fatalf("timeline = %+v", got.Timeline)
	}
	after := call[api.Account](t, h, http.MethodGet, "/v1/accounts/"+toluAcc.Id.String(), tolu.AccessToken, nil, http.StatusOK)
	if after.LedgerBalance.AmountMinor != "750000" {
		t.Fatalf("Tolu's balance = %s, want one debit", after.LedgerBalance.AmountMinor)
	}
	if b := call[api.Account](t, h, http.MethodGet, "/v1/accounts/"+adaAcc.Id.String(), ada.AccessToken, nil, http.StatusOK); b.LedgerBalance.AmountMinor != "250000" {
		t.Fatalf("Ada's balance = %s", b.LedgerBalance.AmountMinor)
	}
	detail := call[api.TransactionDetail](t, h, http.MethodGet, "/v1/transactions/"+sent.TransactionId.String(), tolu.AccessToken, nil, http.StatusOK)
	if detail.Status != api.TransactionStatusCompleted || len(detail.Timeline) != 3 || !detail.CanRepeat {
		t.Fatalf("transaction detail = %+v", detail)
	}
	call[api.Problem](t, h, http.MethodGet, "/v1/transfers/"+sent.Id.String(), ada.AccessToken, nil, http.StatusNotFound)

	// Before paying, the app looks the payee up: Ada by her phone in its local spelling, and
	// an account at another bank by name enquiry with Confirmation of Payee (TRF-1, TRF-3).
	payee := call[api.ResolvedPayee](t, h, http.MethodPost, "/v1/payees/resolve", tolu.AccessToken,
		map[string]string{"kind": "nem", "query": "0803 123 4502"}, http.StatusOK)
	if payee.Kind != api.ResolvedPayeeKindNem || payee.Name != "ada Adeyemi" || payee.AccountNumber != adaNuban.AccountNumber {
		t.Fatalf("payee by phone = %+v", payee)
	}
	other := call[api.ResolvedPayee](t, h, http.MethodPost, "/v1/payees/resolve", tolu.AccessToken,
		map[string]string{"kind": "bank", "bank_code": "058", "account_number": "0123456789", "expected_name": "Chidi Okonkow"}, http.StatusOK)
	if other.Name != "Chidi Okonkwo" || other.NameMatch == nil || other.NameMatch.Result != api.CloseMatch {
		t.Fatalf("other bank = %+v", other)
	}
	if banks := call[api.BankList](t, h, http.MethodGet, "/v1/banks", tolu.AccessToken, nil, http.StatusOK); len(banks.Data) < 20 {
		t.Fatalf("banks = %d", len(banks.Data))
	}

	// To another bank: held, sent by the saga, settled by the sandbox's signed callback.
	if _, err := pool.Exec(t.Context(), `UPDATE simulator_settings SET settings = '{"failure_rate_bps": 0, "timeout_rate_bps": 0,
		"min_delay_seconds": 0, "max_delay_seconds": 0, "name_check": "realistic"}' WHERE name = 'bank_partner'`); err != nil {
		t.Fatal(err)
	}
	ext := `{"source_account_id":"` + toluAcc.Id.String() + `","destination":{"kind":"bank","bank_code":"058",` +
		`"account_number":"0123456789","account_name":"Chidi Okonkwo"},"amount":{"amount_minor":"100000","currency":"NGN"}}`
	// The quote shows the ₦10 fee and what is left of the day before the customer confirms.
	quote := call[api.TransferQuote](t, h, http.MethodPost, "/v1/transfers/quote", tolu.AccessToken, json.RawMessage(ext), http.StatusOK)
	if quote.Fee.AmountMinor != "1000" || quote.TotalDebit.AmountMinor != "101000" || len(quote.Fees) != 1 ||
		quote.Rail != api.Interbank || quote.Limits.KycTier != 1 || quote.Limits.DailyLimit.AmountMinor != "5000000" {
		t.Fatalf("quote = %+v", quote)
	}
	// Lowering the customer's own limit applies at once; raising it back needs a step-up.
	own := call[api.SelfLimits](t, h, http.MethodPut, "/v1/security/limits", tolu.AccessToken,
		api.SetSelfLimitsRequest{DailyLimit: &api.Money{AmountMinor: "50000", Currency: api.CurrencyCodeNGN}}, http.StatusOK)
	if own.DailyLimit == nil || own.DailyLimit.AmountMinor != "50000" || own.KycDailyCap.AmountMinor != "5000000" {
		t.Fatalf("own limits = %+v", own)
	}
	if rec := signedPostKey(t, h, toluKey, tolu.Device.Id, tolu.AccessToken, "/v1/transfers", ext, "nonce-trf-000009", uuid.NewString()); rec.Code != http.StatusUnprocessableEntity ||
		!strings.Contains(rec.Body.String(), "limit_exceeded") {
		t.Fatalf("over own limit = %d: %s", rec.Code, rec.Body)
	}
	call[api.Problem](t, h, http.MethodPut, "/v1/security/limits", tolu.AccessToken, api.SetSelfLimitsRequest{}, http.StatusForbidden)
	if _, err := pool.Exec(t.Context(), `DELETE FROM self_limits`); err != nil {
		t.Fatal(err)
	}
	rec := signedPostKey(t, h, toluKey, tolu.Device.Id, tolu.AccessToken, "/v1/transfers", ext, "nonce-trf-000003", uuid.NewString())
	if rec.Code != http.StatusCreated {
		t.Fatalf("external transfer = %d: %s", rec.Code, rec.Body)
	}
	out := decode[api.Transfer](t, rec.Body.Bytes())
	if out.Status != api.TransferStatusProcessing || out.Rail != api.Interbank || out.Recipient.Name != "Chidi Okonkwo" {
		t.Fatalf("external = %+v", out)
	}
	held := call[api.Account](t, h, http.MethodGet, "/v1/accounts/"+toluAcc.Id.String(), tolu.AccessToken, nil, http.StatusOK)
	if held.LedgerBalance.AmountMinor != "750000" || held.AvailableBalance.AmountMinor != "649000" {
		t.Fatalf("while held: ledger %s, available %s", held.LedgerBalance.AmountMinor, held.AvailableBalance.AmountMinor)
	}
	if err := tr.SendExternal(t.Context(), out.Id); err != nil { // the River job, run inline
		t.Fatal(err)
	}
	if err := sandbox.DeliverCallback(t.Context(), out.Reference); err != nil { // the sandbox's River job
		t.Fatal(err)
	}
	done := call[api.Transfer](t, h, http.MethodGet, "/v1/transfers/"+out.Id.String(), tolu.AccessToken, nil, http.StatusOK)
	if done.Status != api.TransferStatusCompleted || done.Timeline[len(done.Timeline)-1].Label != "Received by Guaranty Trust Bank" {
		t.Fatalf("after the callback = %+v", done)
	}
	paid := call[api.Account](t, h, http.MethodGet, "/v1/accounts/"+toluAcc.Id.String(), tolu.AccessToken, nil, http.StatusOK)
	if paid.LedgerBalance.AmountMinor != "649000" || paid.AvailableBalance.AmountMinor != "649000" {
		t.Fatalf("after settling: ledger %s, available %s", paid.LedgerBalance.AmountMinor, paid.AvailableBalance.AmountMinor)
	}

	// The webhook refuses anything not signed with the partner's secret.
	forged := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/v1/partner-webhooks/sandbox_nip",
		strings.NewReader(`{"event_type":"transfer.settled","reference":"`+out.Reference+`","occurred_at":"2026-11-09T10:00:00Z"}`))
	forged.Header.Set("Content-Type", "application/json")
	forged.Header.Set("Partner-Signature", partners.Sign([]byte("guessed"), time.Now(), []byte("{}")))
	forged.Header.Set("Partner-Event-Id", "forged-1")
	frec := httptest.NewRecorder()
	h.ServeHTTP(frec, forged)
	if frec.Code != http.StatusUnauthorized {
		t.Fatalf("forged callback = %d: %s", frec.Code, frec.Body)
	}
}

func decode[T any](t *testing.T, b []byte) T {
	t.Helper()
	var out T
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return out
}
