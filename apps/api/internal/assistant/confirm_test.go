package assistant

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/assistant/assistantdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

// recorder is an Executor that counts what it was asked to run.
type recorder struct {
	transfers, freezes atomic.Int32
	fail               error
	lastBody           api.CreateTransferRequest
	mu                 sync.Mutex
}

func (r *recorder) Transfer(_ context.Context, b api.CreateTransferRequest) (uuid.UUID, error) {
	r.mu.Lock()
	r.lastBody = b
	r.mu.Unlock()
	r.transfers.Add(1)
	if r.fail != nil {
		return uuid.Nil, r.fail
	}
	return uuid.MustParse("0192f5a4-7c1e-7b3a-9f10-3c5d2e8a4b61"), nil
}

func (r *recorder) FreezeCard(context.Context, uuid.UUID) error { r.freezes.Add(1); return r.fail }

func TestConfirmRunsAnActionOnceAndRefusesTheRest(t *testing.T) {
	t.Parallel()
	pool := testdb.New(t)
	ctx := t.Context()
	user, conv := uuid.New(), uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, first_name, last_name, email, phone, date_of_birth,
		password_hash, terms_version, privacy_version, consent_accepted_at)
		VALUES ($1, 'Ada', 'User', 'confirm@example.com', '+2348066000021', '1996-04-12', 'x', '2026-10', '2026-10', now())`, user); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO assistant_conversations (id, user_id) VALUES ($1, $2)`, conv, user); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	rec := &recorder{}
	svc, err := NewService(Config{
		Store: assistantdb.New(pool), Gateway: NewGateway(&scripted{}), Accounts: fakeAccounts{}, Forecast: fakeForecast{},
		Beneficiaries: fakeBeneficiaries{}, Cards: fakeCards{}, Customers: fakeCustomers{},
		Pool: pool, Executor: rec, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	me := identity.WithPrincipal(ctx, identity.Principal{UserID: user})
	insert := func(kind, details string, expires time.Time) uuid.UUID {
		id := uuid.New()
		if _, err := pool.Exec(ctx, `INSERT INTO prepared_actions (id, user_id, conversation_id, kind, summary, details, expires_at) VALUES ($1, $2, $3, $4, 'draft', $5::jsonb, $6)`,
			id, user, conv, kind, details, expires); err != nil {
			t.Fatal(err)
		}
		return id
	}
	transfer := `{"source_account_id":"0192f5a4-7c1e-7b3a-9f10-3c5d2e8a4b61","amount":{"amount_minor":"500000","currency":"NGN"},` +
		`"destination":{"kind":"nem","nemtag":"mum_a"},"narration":"food"}`

	// A good transfer runs once, answers with its result, and cannot be confirmed again.
	id := insert("transfer", transfer, now.Add(5*time.Minute))
	got, err := svc.Confirm(me, id)
	if err != nil || got.Status != "confirmed" || got.Result == nil || rec.transfers.Load() != 1 {
		t.Fatalf("confirm = %+v, %v, runs = %d", got, err, rec.transfers.Load())
	}
	if rec.lastBody.Amount.AmountMinor != "500000" || rec.lastBody.Narration == nil || *rec.lastBody.Narration != "food" {
		t.Fatalf("the executor must get exactly the drafted body, got %+v", rec.lastBody)
	}
	if _, err := svc.Confirm(me, id); !errors.Is(err, errActionState("confirmed")) || rec.transfers.Load() != 1 {
		t.Fatalf("second confirm: %v, runs = %d", err, rec.transfers.Load())
	}

	// Two confirmations at once run it once.
	race := insert("transfer", transfer, now.Add(5*time.Minute))
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() { defer wg.Done(); _, _ = svc.Confirm(me, race) }()
	}
	wg.Wait()
	if rec.transfers.Load() != 2 {
		t.Fatalf("a raced confirmation ran %d transfers, want 1 more (2 in all)", rec.transfers.Load())
	}

	// An expired draft, a discarded one and another customer's all refuse and run nothing.
	if _, err := svc.Confirm(me, insert("transfer", transfer, now.Add(-time.Minute))); err == nil {
		t.Fatal("an expired action must be refused")
	}
	gone := insert("transfer", transfer, now.Add(time.Minute))
	if _, err := svc.Discard(me, gone); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Confirm(me, gone); err == nil {
		t.Fatal("a discarded action must be refused")
	}
	stranger := identity.WithPrincipal(ctx, identity.Principal{UserID: uuid.New()})
	if _, err := svc.Confirm(stranger, insert("transfer", transfer, now.Add(time.Minute))); !errors.Is(err, problem.NotFound("Action")) {
		t.Fatalf("another customer's action: %v", err)
	}
	if rec.transfers.Load() != 2 {
		t.Fatalf("refused confirmations ran transfers: %d", rec.transfers.Load())
	}

	// A refused payment marks the action failed and shows the customer why.
	rec.fail = problem.New(422, "insufficient_funds", "Not enough money")
	bad := insert("transfer", transfer, now.Add(time.Minute))
	if _, err := svc.Confirm(me, bad); !errors.Is(err, rec.fail) {
		t.Fatalf("a refused payment: %v", err)
	}
	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM prepared_actions WHERE id = $1`, bad).Scan(&status); err != nil || status != "failed" {
		t.Fatalf("status = %q, %v", status, err)
	}
	rec.fail = nil

	// Freezing a card, and a kind the assistant cannot run.
	card := insert("card_freeze", `{"card_id":"0192f5a4-7c1e-7b3a-9f10-3c5d2e8a4b62"}`, now.Add(time.Minute))
	if a, err := svc.Confirm(me, card); err != nil || a.Status != "confirmed" || rec.freezes.Load() != 1 {
		t.Fatalf("freeze = %+v, %v, freezes = %d", a, err, rec.freezes.Load())
	}
	if _, err := svc.Confirm(me, insert("fx_conversion", `{}`, now.Add(time.Minute))); !errors.Is(err, errActionKind) {
		t.Fatalf("an unsupported kind: %v", err)
	}
}
