package httpserver

import (
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

// TestASignedGoalDepositIsMadeOnceAndAnExplicitNullClearsTheRule walks the contract path:
// a signed goal with an auto-save rule, a double-tapped deposit that replays the first
// answer, and a PATCH whose auto_save: null removes the rule while an omitted one keeps it.
func TestASignedGoalDepositIsMadeOnceAndAnExplicitNullClearsTheRule(t *testing.T) {
	t.Parallel()
	s := newFXStack(t)
	tok := s.user.AccessToken
	ngn := call[api.AccountList](t, s.h, http.MethodGet, "/v1/accounts", tok, nil, http.StatusOK).Data[0]
	if err := pgx.BeginFunc(t.Context(), s.pool, func(tx pgx.Tx) error {
		src, err := ledger.SystemAccount(t.Context(), tx, ledger.KindDemoFunding, "NGN")
		if err != nil {
			return err
		}
		amt := money.New(100_000_00, money.NGN)
		_, err = ledger.Post(t.Context(), tx, ledger.Entry{Kind: "demo_funding", Reference: "seed",
			Legs: []ledger.Leg{ledger.Debit(src.ID, amt), ledger.Credit(ngn.Id, amt)}})
		return err
	}); err != nil {
		t.Fatal(err)
	}

	create := `{"name":"Laptop","emoji":"💻","target":{"amount_minor":"5000000","currency":"NGN"},` +
		`"auto_save":{"amount":{"amount_minor":"100000","currency":"NGN"},"frequency":"weekly","source_account_id":"` + ngn.Id.String() + `"}}`
	made := signedPostKey(t, s.h, s.key, s.user.Device.Id, tok, "/v1/savings/goals", create, "nonce-sav-0000001", uuid.NewString())
	if made.Code != http.StatusCreated {
		t.Fatalf("create goal = %d: %s", made.Code, made.Body)
	}
	goal := decode[api.SavingsGoal](t, made.Body.Bytes())
	if goal.AutoSave == nil || goal.AutoSave.Frequency != api.AutoSaveRuleFrequencyWeekly || goal.Status != "active" || goal.Balance.AmountMinor != "0" {
		t.Fatalf("goal = %+v", goal)
	}

	path := "/v1/savings/goals/" + goal.Id.String() + "/deposits"
	body := `{"amount":{"amount_minor":"2000000","currency":"NGN"},"account_id":"` + ngn.Id.String() + `"}`
	key := uuid.NewString()
	first := signedPostKey(t, s.h, s.key, s.user.Device.Id, tok, path, body, "nonce-sav-0000002", key)
	if first.Code != http.StatusCreated {
		t.Fatalf("deposit = %d: %s", first.Code, first.Body)
	}
	second := signedPostKey(t, s.h, s.key, s.user.Device.Id, tok, path, body, "nonce-sav-0000003", key)
	if second.Code != http.StatusCreated || second.Header().Get("Idempotent-Replayed") != "true" || second.Body.String() != first.Body.String() {
		t.Fatalf("double tap = %d %q: %s", second.Code, second.Header().Get("Idempotent-Replayed"), second.Body)
	}
	if got := decode[api.SavingsGoal](t, first.Body.Bytes()); got.Balance.AmountMinor != "2000000" || got.ProgressPct != 40 {
		t.Fatalf("after deposit = %+v", got)
	}
	if n := call[api.Account](t, s.h, http.MethodGet, "/v1/accounts/"+ngn.Id.String(), tok, nil, http.StatusOK); n.LedgerBalance.AmountMinor != "8000000" {
		t.Fatalf("naira = %s, want one ₦20,000 debit", n.LedgerBalance.AmountMinor)
	}
	// An unsigned deposit never reaches the handler.
	if rec := postJSON(t, s.h, path, tok, body); rec.Code != http.StatusBadRequest && rec.Code != http.StatusUnauthorized && rec.Code != http.StatusForbidden {
		t.Fatalf("unsigned deposit = %d: %s", rec.Code, rec.Body)
	}

	patch := func(nonce, body string) api.SavingsGoal {
		t.Helper()
		rec := signedRequest(t, s.h, http.MethodPatch, s.key, s.user.Device.Id, tok, "/v1/savings/goals/"+goal.Id.String(), body, nonce, uuid.NewString())
		if rec.Code != http.StatusOK {
			t.Fatalf("patch %s = %d: %s", body, rec.Code, rec.Body)
		}
		return decode[api.SavingsGoal](t, rec.Body.Bytes())
	}
	if g := patch("nonce-sav-0000004", `{"name":"New laptop"}`); g.Name != "New laptop" || g.AutoSave == nil {
		t.Fatalf("a rename dropped the rule: %+v", g)
	}
	if g := patch("nonce-sav-0000005", `{"auto_save":null}`); g.AutoSave != nil || g.Name != "New laptop" {
		t.Fatalf("auto_save:null left the rule: %+v", g)
	}

	list := call[api.SavingsGoalList](t, s.h, http.MethodGet, "/v1/savings/goals", tok, nil, http.StatusOK)
	if len(list.Data) != 1 || list.Data[0].Id != goal.Id {
		t.Fatalf("list = %+v", list)
	}
	sum := call[api.SavingsSummary](t, s.h, http.MethodGet, "/v1/savings/summary", tok, nil, http.StatusOK)
	if sum.TotalSaved.AmountMinor != "2000000" || sum.GoalsCount != 1 {
		t.Fatalf("summary = %+v", sum)
	}
	call[api.Problem](t, s.h, http.MethodGet, "/v1/savings/goals/"+uuid.NewString(), tok, nil, http.StatusNotFound)
	if rec := signedRequest(t, s.h, http.MethodDelete, s.key, s.user.Device.Id, tok, "/v1/savings/goals/"+goal.Id.String(), "", "nonce-sav-0000006", uuid.NewString()); rec.Code != http.StatusNoContent {
		t.Fatalf("close = %d: %s", rec.Code, rec.Body)
	}
	if n := call[api.Account](t, s.h, http.MethodGet, "/v1/accounts/"+ngn.Id.String(), tok, nil, http.StatusOK); !strings.HasPrefix(n.LedgerBalance.AmountMinor, "10000000") {
		t.Fatalf("naira after closing = %s, want the full ₦100,000 back", n.LedgerBalance.AmountMinor)
	}
}

// TestALockIsQuotedMadeOnceAndBrokenWithItsPenalty walks locked savings over HTTP: the
// disclosure, a double-tapped signed lock that replays, and an early break.
func TestALockIsQuotedMadeOnceAndBrokenWithItsPenalty(t *testing.T) {
	t.Parallel()
	s := newFXStack(t)
	tok := s.user.AccessToken
	ngn := call[api.AccountList](t, s.h, http.MethodGet, "/v1/accounts", tok, nil, http.StatusOK).Data[0]
	if err := pgx.BeginFunc(t.Context(), s.pool, func(tx pgx.Tx) error {
		src, err := ledger.SystemAccount(t.Context(), tx, ledger.KindDemoFunding, "NGN")
		if err != nil {
			return err
		}
		amt := money.New(100_000_00, money.NGN)
		_, err = ledger.Post(t.Context(), tx, ledger.Entry{Kind: "demo_funding", Reference: "seed",
			Legs: []ledger.Leg{ledger.Debit(src.ID, amt), ledger.Credit(ngn.Id, amt)}})
		return err
	}); err != nil {
		t.Fatal(err)
	}

	quote := call[api.LockQuote](t, s.h, http.MethodPost, "/v1/savings/locks/quote", tok,
		map[string]any{"amount": map[string]string{"amount_minor": "5000000", "currency": "NGN"}, "term_days": 90}, http.StatusOK)
	if quote.RateBps != 1400 || quote.InterestAtMaturity.AmountMinor != "172602" || quote.EarlyBreakPenaltyBps != 5000 || quote.EarlyBreakExplanation == "" {
		t.Fatalf("quote = %+v", quote)
	}
	call[api.Problem](t, s.h, http.MethodPost, "/v1/savings/locks/quote", tok,
		map[string]any{"amount": map[string]string{"amount_minor": "5000000", "currency": "NGN"}, "term_days": 45}, http.StatusUnprocessableEntity)

	body := `{"amount":{"amount_minor":"5000000","currency":"NGN"},"term_days":90,"source_account_id":"` + ngn.Id.String() + `","accepted_terms":true}`
	key := uuid.NewString()
	first := signedPostKey(t, s.h, s.key, s.user.Device.Id, tok, "/v1/savings/locks", body, "nonce-lck-0000001", key)
	if first.Code != http.StatusCreated {
		t.Fatalf("create lock = %d: %s", first.Code, first.Body)
	}
	second := signedPostKey(t, s.h, s.key, s.user.Device.Id, tok, "/v1/savings/locks", body, "nonce-lck-0000002", key)
	if second.Code != http.StatusCreated || second.Header().Get("Idempotent-Replayed") != "true" || second.Body.String() != first.Body.String() {
		t.Fatalf("double tap = %d %q: %s", second.Code, second.Header().Get("Idempotent-Replayed"), second.Body)
	}
	lock := decode[api.LockedSaving](t, first.Body.Bytes())
	if lock.Status != api.LockedSavingStatusActive || lock.Principal.AmountMinor != "5000000" || lock.ExpectedInterest.AmountMinor != "172602" {
		t.Fatalf("lock = %+v", lock)
	}
	if n := call[api.Account](t, s.h, http.MethodGet, "/v1/accounts/"+ngn.Id.String(), tok, nil, http.StatusOK); n.LedgerBalance.AmountMinor != "5000000" {
		t.Fatalf("naira = %s, want one ₦50,000 debit", n.LedgerBalance.AmountMinor)
	}
	if got := call[api.LockedSaving](t, s.h, http.MethodGet, "/v1/savings/locks/"+lock.Id.String(), tok, nil, http.StatusOK); got.Id != lock.Id {
		t.Fatalf("get = %+v", got)
	}
	if list := call[api.LockedSavingList](t, s.h, http.MethodGet, "/v1/savings/locks", tok, nil, http.StatusOK); len(list.Data) != 1 {
		t.Fatalf("list = %+v", list)
	}

	broke := signedPostKey(t, s.h, s.key, s.user.Device.Id, tok, "/v1/savings/locks/"+lock.Id.String()+"/break", "", "nonce-lck-0000003", uuid.NewString())
	if broke.Code != http.StatusOK {
		t.Fatalf("break = %d: %s", broke.Code, broke.Body)
	}
	if b := decode[api.LockedSaving](t, broke.Body.Bytes()); b.Status != api.LockedSavingStatusBroken || b.PaidOut == nil || b.PaidOut.AmountMinor != "5000000" {
		t.Fatalf("broken = %+v (no interest yet, so the whole principal comes back)", b)
	}
	if n := call[api.Account](t, s.h, http.MethodGet, "/v1/accounts/"+ngn.Id.String(), tok, nil, http.StatusOK); n.LedgerBalance.AmountMinor != "10000000" {
		t.Fatalf("naira after breaking = %s", n.LedgerBalance.AmountMinor)
	}
}
