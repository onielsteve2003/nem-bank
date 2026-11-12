package demo

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/kyc"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/kyc/kycdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/limits"
)

type fixedRules struct{}

func (fixedRules) Rules() limits.Rules { return limits.DefaultRules() }

// reviewer remembers the ruling it was asked for.
type reviewer struct{ got []kyc.Decision }

func (r *reviewer) Decide(_ context.Context, d kyc.Decision) (kycdb.KycSubmission, error) {
	r.got = append(r.got, d)
	return kycdb.KycSubmission{}, nil
}

func withService(t *testing.T) (*Service, *pgxpool.Pool, *reviewer) {
	t.Helper()
	svc, pool := newService(t)
	rv := &reviewer{}
	svc.rules, svc.kyc = fixedRules{}, rv
	return svc, pool, rv
}

// signIn starts a demo customer and returns a context carrying its session.
func signIn(t *testing.T, svc *Service, persona string) (context.Context, identity.AuthResult, uuid.UUID) {
	t.Helper()
	res, err := svc.Start(t.Context(), persona, device(t))
	if err != nil {
		t.Fatal(err)
	}
	var account uuid.UUID
	if err := svc.pool.QueryRow(t.Context(), `SELECT account_id FROM customer_accounts WHERE user_id = $1 AND currency = 'NGN'`, res.User.ID).Scan(&account); err != nil {
		t.Fatal(err)
	}
	ctx := identity.WithPrincipal(t.Context(), identity.Principal{UserID: res.User.ID, SessionID: uuid.New(), DeviceID: res.Device.ID})
	return ctx, res, account
}

func balance(t *testing.T, pool *pgxpool.Pool, account uuid.UUID) int64 {
	t.Helper()
	var b int64
	if err := pool.QueryRow(t.Context(), `SELECT balance_minor FROM ledger_accounts WHERE id = $1`, account).Scan(&b); err != nil {
		t.Fatal(err)
	}
	return b
}

func TestFundAddsMoneyButNotPastTheTierCap(t *testing.T) {
	svc, pool, _ := withService(t)
	ctx, _, account := signIn(t, svc, "bisi")
	before := balance(t, pool, account)

	tx, err := svc.Fund(ctx, account, money.New(5_000_00, money.NGN))
	if err != nil {
		t.Fatal(err)
	}
	if tx.Type != "deposit" || tx.Direction != "credit" || tx.AmountMinor != 5_000_00 {
		t.Fatalf("line = %+v", tx)
	}
	if got := balance(t, pool, account); got != before+5_000_00 {
		t.Fatalf("balance %d, want %d", got, before+5_000_00)
	}

	// Tier 2 holds ₦500,000 at most: a fund that would pass it is refused and posts nothing.
	if _, err := svc.Fund(ctx, account, money.New(900_000_00, money.NGN)); !errors.Is(err, errMaxBalance) {
		t.Fatalf("err = %v, want max balance", err)
	}
	if got := balance(t, pool, account); got != before+5_000_00 {
		t.Fatalf("a refused fund changed the balance to %d", got)
	}
	if _, err := svc.Fund(ctx, account, money.New(1_00, money.USD)); err == nil {
		t.Fatal("a dollar amount must not fund a naira account")
	}
	if _, err := svc.Fund(ctx, uuid.New(), money.New(1_00, money.NGN)); err == nil {
		t.Fatal("an account that is not the caller's must be refused")
	}
}

func TestDemoControlsRefuseARealCustomer(t *testing.T) {
	svc, pool, _ := withService(t)
	var id uuid.UUID
	if err := pool.QueryRow(t.Context(), `
		INSERT INTO users (id, first_name, last_name, email, phone, date_of_birth, password_hash, terms_version, privacy_version, consent_accepted_at)
		VALUES (gen_random_uuid(), 'Real', 'Person', 'real@example.com', '+2348031234567', '1990-01-01', 'x', 't', 'p', now()) RETURNING id`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	ctx := identity.WithPrincipal(t.Context(), identity.Principal{UserID: id})
	if _, err := svc.Fund(ctx, uuid.New(), money.New(1_00, money.NGN)); !errors.Is(err, errNotDemo) {
		t.Fatalf("fund: %v", err)
	}
	for name, err := range map[string]error{
		"tier": svc.SetKycTier(ctx, 1), "fail": svc.FailNextTransfer(ctx), "review": svc.SetKycReview(ctx, "approve"),
	} {
		if !errors.Is(err, errNotDemo) {
			t.Fatalf("%s: %v", name, err)
		}
	}
}

func TestSetKycTierClearsWhatSitsAbove(t *testing.T) {
	svc, pool, _ := withService(t)
	ctx, res, _ := signIn(t, svc, "emeka") // Tier 3, approved
	uid := res.User.ID
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO kyc_identity_checks (id, user_id, kind, verified, name_result, name_confidence, provider)
		VALUES (gen_random_uuid(), $1, 'bvn', true, 'match', 1, 'sandbox')`, uid); err != nil {
		t.Fatal(err)
	}
	count := func(table string) int {
		var n int
		if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM `+table+` WHERE user_id = $1`, uid).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	tierOf := func() (int, string) {
		var tier int
		var status string
		if err := pool.QueryRow(t.Context(), `SELECT kyc_tier, kyc_status FROM users WHERE id = $1`, uid).Scan(&tier, &status); err != nil {
			t.Fatal(err)
		}
		return tier, status
	}

	if err := svc.SetKycTier(ctx, 2); err != nil {
		t.Fatal(err)
	}
	if tier, status := tierOf(); tier != 2 || status != "not_started" {
		t.Fatalf("tier %d status %q", tier, status)
	}
	if count("kyc_identity_checks") != 1 {
		t.Fatal("Tier 2 keeps the BVN check")
	}
	if err := svc.SetKycTier(ctx, 1); err != nil {
		t.Fatal(err)
	}
	if count("kyc_identity_checks") != 0 {
		t.Fatal("Tier 1 clears the BVN check")
	}
	if err := svc.SetKycTier(ctx, 3); err != nil {
		t.Fatal(err)
	}
	if tier, status := tierOf(); tier != 3 || status != "approved" {
		t.Fatalf("tier %d status %q", tier, status)
	}
	if err := svc.SetKycTier(ctx, 4); err == nil {
		t.Fatal("tier 4 does not exist")
	}
}

func TestFailNextTransferIsSpentByTheFirstTransfer(t *testing.T) {
	svc, pool, _ := withService(t)
	ctx, res, account := signIn(t, svc, "tolu")

	ref := "NEM20261112ABC123"
	var txn uuid.UUID
	if err := pool.QueryRow(t.Context(), `SELECT id FROM transactions WHERE user_id = $1 LIMIT 1`, res.User.ID).Scan(&txn); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO transfers (id, user_id, reference, rail, source_account_id, recipient, currency, amount_minor, narration, transaction_id, bank_code, account_number, partner, saga_deadline, duress_blocked)
		VALUES (gen_random_uuid(), $1, $2, 'interbank', $3, '{"name":"Friend"}', 'NGN', 1000, 'x', $4, '058', '0123456789', 'sandbox_nip', now() + interval '1 hour', true)`,
		res.User.ID, ref, account, txn); err != nil {
		t.Fatal(err)
	}

	if svc.ConsumeFailNext(t.Context(), ref) {
		t.Fatal("nothing was armed yet")
	}
	if err := svc.FailNextTransfer(ctx); err != nil {
		t.Fatal(err)
	}
	if !svc.ConsumeFailNext(t.Context(), ref) {
		t.Fatal("the armed failure was not used")
	}
	if svc.ConsumeFailNext(t.Context(), ref) {
		t.Fatal("one switch fails one transfer")
	}
	if svc.ConsumeFailNext(t.Context(), "NEM20261112ZZZZZZ") {
		t.Fatal("an unknown reference must not fail")
	}
}

func TestAutoReviewUsesTheChoiceOnce(t *testing.T) {
	svc, _, rv := withService(t)
	ctx, res, _ := signIn(t, svc, "tolu")
	sub := uuid.New()

	if err := svc.AutoReview(ctx, res.User.ID, sub); err != nil || len(rv.got) != 0 {
		t.Fatalf("no choice made, yet reviewed: %v %v", err, rv.got)
	}
	if err := svc.SetKycReview(ctx, "resubmit"); err != nil {
		t.Fatal(err)
	}
	if err := svc.AutoReview(ctx, res.User.ID, sub); err != nil {
		t.Fatal(err)
	}
	if len(rv.got) != 1 {
		t.Fatalf("decisions = %d, want 1", len(rv.got))
	}
	d := rv.got[0]
	if d.SubmissionID != sub || d.Outcome != "resubmit" || d.Reason == "" || len(d.ResubmitDocuments) != 1 {
		t.Fatalf("decision = %+v", d)
	}
	if err := svc.AutoReview(ctx, res.User.ID, sub); err != nil || len(rv.got) != 1 {
		t.Fatal("the choice must be used up after one review")
	}
	if err := svc.SetKycReview(ctx, "maybe"); err == nil {
		t.Fatal("an unknown outcome must be refused")
	}
}

// recorder is an Advancer that remembers who it was asked to advance, and to when.
type recorder struct {
	users []uuid.UUID
	asOf  []time.Time
}

func (r *recorder) AdvanceUser(_ context.Context, id uuid.UUID, asOf time.Time) error {
	r.users, r.asOf = append(r.users, id), append(r.asOf, asOf)
	return nil
}

func TestTimeTravelMovesTheCallersClockAndAdvancesTheirRecords(t *testing.T) {
	svc, pool, _ := withService(t)
	rec := &recorder{}
	svc.advancers = []Advancer{rec}
	ctx, res, _ := signIn(t, svc, "tolu")

	c, err := svc.TimeTravel(ctx, 30)
	if err != nil || c.OffsetDays != 30 {
		t.Fatalf("clock = %+v, %v", c, err)
	}
	if len(rec.users) != 1 || rec.users[0] != res.User.ID || !rec.asOf[0].Equal(c.Now) {
		t.Fatalf("advanced %v as of %v, clock %v", rec.users, rec.asOf, c.Now)
	}
	if d := time.Until(c.Now); d < 29*24*time.Hour || d > 31*24*time.Hour {
		t.Fatalf("the demo date is %v from now", d)
	}
	c, err = svc.TimeTravel(ctx, 10)
	if err != nil || c.OffsetDays != 40 {
		t.Fatalf("second jump = %+v, %v", c, err)
	}
	var stored int
	if err := pool.QueryRow(t.Context(), `SELECT demo_offset_days FROM users WHERE id = $1`, res.User.ID).Scan(&stored); err != nil || stored != 40 {
		t.Fatalf("stored offset = %d, %v", stored, err)
	}
	// Too far, or nonsense, changes nothing.
	for _, days := range []int{0, -1, 366, 330} {
		if _, err := svc.TimeTravel(ctx, days); err == nil {
			t.Fatalf("%d days was accepted", days)
		}
	}
	if len(rec.users) != 2 {
		t.Fatalf("a refused jump still advanced records (%d calls)", len(rec.users))
	}
}

func TestTimeTravelRefusesARealCustomer(t *testing.T) {
	svc, pool, _ := withService(t)
	var id uuid.UUID
	if err := pool.QueryRow(t.Context(), `
		INSERT INTO users (id, first_name, last_name, email, phone, date_of_birth, password_hash, terms_version, privacy_version, consent_accepted_at)
		VALUES (gen_random_uuid(), 'Real', 'Person', 'real2@example.com', '+2348031234568', '1990-01-01', 'x', 't', 'p', now()) RETURNING id`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	ctx := identity.WithPrincipal(t.Context(), identity.Principal{UserID: id})
	if _, err := svc.TimeTravel(ctx, 5); !errors.Is(err, errNotDemo) {
		t.Fatalf("err = %v", err)
	}
}
