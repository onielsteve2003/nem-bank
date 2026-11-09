package transfers

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

type profiles struct {
	mu      sync.Mutex
	m       map[uuid.UUID]identity.CustomerProfile
	coolOff identity.CoolOff
}

func (p *profiles) CustomerProfile(_ context.Context, id uuid.UUID) (identity.CustomerProfile, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.m[id], nil
}

// FindCustomer matches the @nemtag only; identity's own tests cover phones.
func (p *profiles) FindCustomer(_ context.Context, handle string) (uuid.UUID, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for id, prof := range p.m {
		if prof.Nemtag != nil && "@"+*prof.Nemtag == handle {
			return id, nil
		}
	}
	return uuid.Nil, identity.ErrNoSuchCustomer
}

// CoolOff is off unless a test turns it on.
func (p *profiles) CoolOff(context.Context) (identity.CoolOff, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.coolOff, nil
}

func (p *profiles) set(id uuid.UUID, prof identity.CustomerProfile) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.m[id] = prof
}

type fixture struct {
	t     *testing.T
	pool  *pgxpool.Pool
	accts *accounts.Service
	svc   *Service
	profs *profiles
	n     atomic.Int32
}

func newFixture(t *testing.T) *fixture { return newFixtureWith(t, nil) }

// newFixtureWith lets a test change the service's configuration (partner, clock, saga).
func newFixtureWith(t *testing.T, tweak func(*Config)) *fixture {
	t.Helper()
	pool := testdb.New(t)
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	f := &fixture{t: t, pool: pool, profs: &profiles{m: map[uuid.UUID]identity.CustomerProfile{}}}
	var err error
	f.accts, err = accounts.NewService(accounts.Config{
		Pool: pool, Customers: f.profs, Logger: quiet,
		Timelines: func(ctx context.Context, id uuid.UUID) ([]api.TimelineEvent, error) { return f.svc.Timeline(ctx, id) },
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg := Config{Pool: pool, Accounts: f.accts, Customers: f.profs, Logger: quiet}
	if tweak != nil {
		tweak(&cfg)
	}
	if f.svc, err = NewService(cfg); err != nil {
		t.Fatal(err)
	}
	return f
}

type customer struct {
	ctx     context.Context
	id      uuid.UUID
	account uuid.UUID
	number  string
}

// customer signs up a customer with an NGN account holding balance kobo.
func (f *fixture) customer(name, tag string, balance int64) customer {
	f.t.Helper()
	ctx := f.t.Context()
	id := uuid.New()
	n := f.n.Add(1)
	if _, err := f.pool.Exec(ctx, `INSERT INTO users (id, first_name, last_name, email, phone, date_of_birth,
		password_hash, terms_version, privacy_version, consent_accepted_at)
		VALUES ($1, $2, 'Test', $3, $4, '1996-04-12', 'x', '2026-10', '2026-10', now())`,
		id, name, fmt.Sprintf("t%d@example.com", n), fmt.Sprintf("+2348031%06d", n)); err != nil {
		f.t.Fatal(err)
	}
	if err := pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		return accounts.OpenCurrentAccount(ctx, tx, identity.NewCustomer{UserID: id, Name: name + " Test"})
	}); err != nil {
		f.t.Fatal(err)
	}
	f.profs.set(id, identity.CustomerProfile{Name: name + " Test", Nemtag: &tag, KycTier: 2})
	c := customer{ctx: identity.WithPrincipal(ctx, identity.Principal{UserID: id}), id: id}
	accs, err := f.accts.List(c.ctx)
	if err != nil {
		f.t.Fatal(err)
	}
	c.account, c.number = accs[0].AccountID, accs[0].AccountNumber
	if balance > 0 {
		if err := pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
			src, err := ledger.SystemAccount(ctx, tx, ledger.KindDemoFunding, "NGN")
			if err != nil {
				return err
			}
			_, err = ledger.Post(ctx, tx, ledger.Entry{Kind: "demo_funding", Reference: "seed",
				Legs: []ledger.Leg{ledger.Debit(src.ID, ngn(balance)), ledger.Credit(c.account, ngn(balance))}})
			return err
		}); err != nil {
			f.t.Fatal(err)
		}
	}
	return c
}

func (f *fixture) balance(c customer) int64 {
	f.t.Helper()
	b, err := ledger.GetBalances(f.t.Context(), f.pool, c.account)
	if err != nil {
		f.t.Fatal(err)
	}
	return b.Ledger.Amount()
}

func ngn(minor int64) money.Money { return money.New(minor, money.NGN) }

func toNem(number string) api.TransferDestination {
	var d api.TransferDestination
	if err := d.FromNemDestination(api.NemDestination{Kind: "nem", AccountNumber: number}); err != nil {
		panic(err)
	}
	return d
}

func toBank(code, number string) api.TransferDestination {
	var d api.TransferDestination
	if err := d.FromBankDestination(api.BankDestination{Kind: "bank", BankCode: code, AccountNumber: number, AccountName: "X"}); err != nil {
		panic(err)
	}
	return d
}

func statuses(v View) []string {
	out := make([]string, len(v.Timeline))
	for i, e := range v.Timeline {
		out[i] = e.Status
	}
	return out
}

func TestInternalTransferMovesMoneyInOneTransaction(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu := f.customer("Tolu", "tolu", 5_000_000)
	ada := f.customer("Ada", "ada", 0)

	v, err := f.svc.Create(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(1_250_000), Narration: "  Rent share  "})
	if err != nil {
		t.Fatal(err)
	}
	if v.Status != "completed" || v.Rail != "internal" || v.EntryID == nil || v.Narration != "Rent share" {
		t.Fatalf("transfer = %+v", v.Transfer)
	}
	if got := fmt.Sprint(statuses(v)); got != "[created risk_checked completed]" {
		t.Fatalf("timeline = %s", got)
	}
	// Nem to Nem is free for the sender; ₦12,500 is over the EMTL threshold, so the
	// receiver pays the ₦50 levy out of it.
	if v.FeeMinor != 0 || f.balance(tolu) != 3_750_000 || f.balance(ada) != 1_245_000 {
		t.Fatalf("fee %d, balances = %d, %d", v.FeeMinor, f.balance(tolu), f.balance(ada))
	}
	if levy, err := ledger.SystemAccount(t.Context(), f.pool, ledger.KindLevyPayable, "NGN"); err != nil || levy.BalanceMinor != 5_000 {
		t.Fatalf("levy payable = %d, %v", levy.BalanceMinor, err)
	}

	// The sender's line is completed, carries the transfer and its timeline.
	out, err := f.accts.Transaction(tolu.ctx, v.TransactionID)
	if err != nil {
		t.Fatal(err)
	}
	if out.Status != "completed" || out.Type != "transfer_out" || *out.BalanceAfterMinor != 3_750_000 || !out.CanRepeat || len(out.Timeline) != 3 {
		t.Fatalf("sender line = %+v", out)
	}
	// The recipient's line names the sender, not the other way round.
	in, _, err := f.accts.Transactions(ada.ctx, accounts.Filter{})
	if err != nil || len(in) != 1 || in[0].Type != "transfer_in" || in[0].Direction != "credit" || *in[0].BalanceAfterMinor != 1_245_000 ||
		in[0].AmountMinor != 1_250_000 || in[0].FeeMinor == nil || *in[0].FeeMinor != 5_000 || *in[0].FeeCode != "emtl" {
		t.Fatalf("recipient lines = %+v, %v", in, err)
	}
	var events int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM outbox_events WHERE topic = 'transfer.completed' AND aggregate_id = $1`,
		v.ID.String()).Scan(&events); err != nil || events != 1 {
		t.Fatalf("completed events = %d, %v", events, err)
	}
	j, err := TransferJSON(v)
	if err != nil || j.TotalDebit.AmountMinor != "1250000" || j.Fee.AmountMinor != "0" || *j.Recipient.Nemtag != "ada" ||
		j.Recipient.AccountNumberMasked != accounts.MaskNumber(ada.number) {
		t.Fatalf("json = %+v, %v", j, err)
	}

	// A Nem account given as a bank destination with Nem's bank code is internal too.
	if v2, err := f.svc.Create(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toBank(accounts.BankCode, ada.number), Amount: ngn(100)}); err != nil ||
		v2.Status != "completed" || v2.Narration != "Transfer to Ada Test" {
		t.Fatalf("bank-code transfer = %+v, %v", v2.Transfer, err)
	}
}

func TestRefusedTransfersLeaveNothingBehind(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu := f.customer("Tolu", "tolu", 100_000)
	ada := f.customer("Ada", "ada", 0)
	usd, err := func() (accounts.View, error) { return f.accts.OpenWallet(tolu.ctx, money.USD) }()
	if err != nil {
		t.Fatal(err)
	}

	for name, tc := range map[string]struct {
		req  Request
		code string
	}{
		"insufficient":                      {Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(100_001)}, "insufficient_funds"},
		"own account":                       {Request{SourceAccountID: tolu.account, Destination: toNem(tolu.number), Amount: ngn(100)}, "validation_failed"},
		"unknown":                           {Request{SourceAccountID: tolu.account, Destination: toNem("0000014579"), Amount: ngn(100)}, "account_not_found"},
		"wallet source":                     {Request{SourceAccountID: usd.AccountID, Destination: toNem(ada.number), Amount: money.New(100, money.USD)}, "validation_failed"},
		"no such account at the other bank": {Request{SourceAccountID: tolu.account, Destination: toBank("058", "1234560000"), Amount: ngn(100)}, "account_not_found"},
		"unknown bank":                      {Request{SourceAccountID: tolu.account, Destination: toBank("999", "0123456789"), Amount: ngn(100)}, problem.CodeValidationFailed},
		"insufficient for another bank":     {Request{SourceAccountID: tolu.account, Destination: toBank("058", "0123456789"), Amount: ngn(100_001)}, "insufficient_funds"},
		"not my source":                     {Request{SourceAccountID: ada.account, Destination: toNem(tolu.number), Amount: ngn(100)}, problem.CodeNotFound},
	} {
		_, err := f.svc.Create(tolu.ctx, tc.req)
		var p *problem.Error
		if !errors.As(err, &p) || p.Code != tc.code {
			t.Errorf("%s: %v, want %s", name, err, tc.code)
		}
	}
	var transfers, lines int
	if err := f.pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM transfers), (SELECT count(*) FROM transactions)`).Scan(&transfers, &lines); err != nil {
		t.Fatal(err)
	}
	if transfers != 0 || lines != 0 || f.balance(tolu) != 100_000 {
		t.Fatalf("after refusals: %d transfers, %d lines, balance %d", transfers, lines, f.balance(tolu))
	}
}

func TestDuressTransfersLookSentAndAreStoppedByTheRealPIN(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu := f.customer("Tolu", "tolu", 5_000_000)
	ada := f.customer("Ada", "ada", 0)
	prof, _ := f.profs.CustomerProfile(t.Context(), tolu.id)
	prof.InDuress = true
	f.profs.set(tolu.id, prof)

	// Only the decoy balance (₦3,850) can appear to leave.
	var p *problem.Error
	if _, err := f.svc.Create(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(385_001)}); !errors.As(err, &p) || p.Code != "insufficient_funds" {
		t.Fatalf("over the decoy: %v", err)
	}
	v, err := f.svc.Create(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(300_000)})
	if err != nil {
		t.Fatal(err)
	}
	if v.Status != "processing" || !v.DuressBlocked || v.EntryID != nil || f.balance(tolu) != 5_000_000 || f.balance(ada) != 0 {
		t.Fatalf("duress transfer = %+v", v.Transfer)
	}

	if err := pgx.BeginFunc(t.Context(), f.pool, func(tx pgx.Tx) error { return f.svc.StopDuressTransfers(t.Context(), tx, tolu.id) }); err != nil {
		t.Fatal(err)
	}
	stopped, err := f.svc.Get(tolu.ctx, v.ID)
	if err != nil {
		t.Fatal(err)
	}
	last := stopped.Timeline[len(stopped.Timeline)-1]
	if stopped.Status != "failed" || last.Label != "Stopped by Nem" || f.balance(tolu) != 5_000_000 {
		t.Fatalf("stopped = %+v, last %+v", stopped.Transfer, last)
	}
	prof.InDuress = false
	f.profs.set(tolu.id, prof)
	line, err := f.accts.Transaction(tolu.ctx, v.TransactionID)
	if err != nil || line.Status != "failed" {
		t.Fatalf("line = %+v, %v", line, err)
	}
}

func TestListPagesAndFilters(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu := f.customer("Tolu", "tolu", 1_000_000)
	ada := f.customer("Ada", "ada", 0)
	for range 3 {
		if _, err := f.svc.Create(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(1_000)}); err != nil {
			t.Fatal(err)
		}
	}
	two := 2
	page1, info, err := f.svc.List(tolu.ctx, nil, nil, &two)
	if err != nil || len(page1) != 2 || info.NextCursor == nil || len(page1[0].Timeline) != 3 {
		t.Fatalf("page 1 = %d, %+v, %v", len(page1), info, err)
	}
	page2, info, err := f.svc.List(tolu.ctx, nil, info.NextCursor, &two)
	if err != nil || len(page2) != 1 || info.NextCursor != nil || page2[0].ID == page1[1].ID {
		t.Fatalf("page 2 = %d, %+v, %v", len(page2), info, err)
	}
	failed := "failed"
	if rows, _, err := f.svc.List(tolu.ctx, &failed, nil, nil); err != nil || len(rows) != 0 {
		t.Fatalf("failed = %d, %v", len(rows), err)
	}
	if rows, _, err := f.svc.List(ada.ctx, nil, nil, nil); err != nil || len(rows) != 0 {
		t.Fatalf("the recipient sees the sender's transfers: %d, %v", len(rows), err)
	}
	if _, err := f.svc.Get(ada.ctx, page1[0].ID); !errors.Is(err, ErrTransferNotFound) {
		t.Fatalf("recipient get: %v", err)
	}
}

// TestTheDatabaseEnforcesTheSameStateMachine tries every (from, to) pair against the
// trigger and checks it agrees with CanMove, so the two tables can never drift apart.
func TestTheDatabaseEnforcesTheSameStateMachine(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu := f.customer("Tolu", "tolu", 1_000_000)
	ada := f.customer("Ada", "ada", 0)
	v, err := f.svc.Create(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(1_000)})
	if err != nil {
		t.Fatal(err)
	}
	all := []Status{Created, RiskChecked, PendingStepUp, Delayed, HeldForReview, Processing, Completed, Failed, Reversed, Rejected, Cancelled}
	ctx := t.Context()
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// delayed needs a release time and money set aside (or a duress look-alike).
	if _, err := tx.Exec(ctx, `UPDATE transfers SET release_at = now(), duress_blocked = true WHERE id = $1`, v.ID); err != nil {
		t.Fatal(err)
	}
	// Triggers are skipped (replica role) only to put the row in each starting state.
	for _, from := range all {
		for _, to := range all {
			if from == to {
				continue
			}
			if _, err := tx.Exec(ctx, `SET LOCAL session_replication_role = replica`); err != nil {
				t.Fatal(err)
			}
			if _, err := tx.Exec(ctx, `UPDATE transfers SET status = $1 WHERE id = $2`, string(from), v.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := tx.Exec(ctx, `SET LOCAL session_replication_role = origin`); err != nil {
				t.Fatal(err)
			}
			if _, err := tx.Exec(ctx, `SAVEPOINT pair`); err != nil {
				t.Fatal(err)
			}
			_, err := tx.Exec(ctx, `UPDATE transfers SET status = $1 WHERE id = $2`, string(to), v.ID)
			if db := err == nil; db != CanMove(from, to) {
				t.Errorf("%s → %s: database allows = %v, CanMove = %v (%v)", from, to, db, CanMove(from, to), err)
			}
			if _, err := tx.Exec(ctx, `ROLLBACK TO SAVEPOINT pair`); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, s := range []Status{Completed, Reversed, Rejected, Cancelled} {
		if !Terminal(s) {
			t.Errorf("%s should be terminal", s)
		}
	}
}

func TestReferencesLookLikeTheContractExample(t *testing.T) {
	t.Parallel()
	seen := map[string]bool{}
	for range 200 {
		r, err := newReference(day())
		if err != nil {
			t.Fatal(err)
		}
		if len(r) != 17 || r[:11] != "NEM20261109" || seen[r] {
			t.Fatalf("reference %q", r)
		}
		seen[r] = true
	}
}

func day() time.Time { return time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC) }
