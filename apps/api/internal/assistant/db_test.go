package assistant

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/assistant/assistantdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/forecast"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/forecast/forecastdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

// These run the real SQL (migration 00032 and the forecast queries) against Postgres; the
// rest of the package uses an in-memory store.

func TestSQLAgainstPostgres(t *testing.T) {
	pool := testdb.New(t)
	ctx := t.Context()

	id := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, first_name, last_name, email, phone, nemtag, date_of_birth,
		password_hash, terms_version, privacy_version, consent_accepted_at, created_at)
		VALUES ($1, 'Ada', 'User', 'asst@example.com', '+2348066000001', 'asst1', '1996-04-12', 'x', '2026-10', '2026-10', now(), now() - interval '200 days')`, id); err != nil {
		t.Fatal(err)
	}
	if err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		return accounts.OpenCurrentAccount(ctx, tx, identity.NewCustomer{UserID: id, Name: "Ada User"})
	}); err != nil {
		t.Fatal(err)
	}
	var ngn uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT account_id FROM customer_accounts WHERE user_id = $1 AND currency = 'NGN'`, id).Scan(&ngn); err != nil {
		t.Fatal(err)
	}
	record := func(typ, direction, category, merchant string, kobo int64, at time.Time) uuid.UUID {
		t.Helper()
		var line accounts.Line
		err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
			src, err := ledger.SystemAccount(ctx, tx, ledger.KindDemoFunding, "NGN")
			if err != nil {
				return err
			}
			amt := money.New(kobo, money.NGN)
			legs := []ledger.Leg{ledger.Debit(src.ID, amt), ledger.Credit(ngn, amt)}
			if direction == "debit" {
				legs = []ledger.Leg{ledger.Debit(ngn, amt), ledger.Credit(src.ID, amt)}
			}
			posted, err := ledger.Post(ctx, tx, ledger.Entry{Kind: "demo_funding", Reference: "seed", Legs: legs})
			if err != nil {
				return err
			}
			line = accounts.Line{
				UserID: id, AccountID: ngn, Type: typ, Direction: direction, Status: "completed", Amount: amt, Entry: &posted,
				Narration: "seed", Reference: "seed", Category: category, At: at, Counterparty: api.Counterparty{Name: merchant},
			}
			_, err = accounts.Record(ctx, tx, line)
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		var lineID uuid.UUID
		if err := pool.QueryRow(ctx, `SELECT id FROM transactions WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, id).Scan(&lineID); err != nil {
			t.Fatal(err)
		}
		return lineID
	}

	now := time.Now().UTC()
	record("deposit", "credit", "other", "Seed", 5_000_000_00, now.AddDate(0, 0, -150))
	for _, m := range []int{3, 2, 1} {
		record("card_payment", "debit", "subscriptions", "Netflix", 4_500_00, now.AddDate(0, -m, 0))
		record("deposit", "credit", "salary_income", "Employer", 400_000_00, now.AddDate(0, -m, -1))
	}
	record("card_payment", "debit", "food", "Mr Biggs", 2_000_00, now.AddDate(0, 0, -3))
	record("transfer_out", "debit", "transfers", "Someone", 10_000_00, now.AddDate(0, 0, -2))

	fq := forecastdb.New(pool)
	cands, err := fq.RecurringCandidates(ctx, forecastdb.RecurringCandidatesParams{UserID: id, Since: now.AddDate(-1, 0, 0)})
	if err != nil || len(cands) != 3 || cands[0].Merchant != "Netflix" {
		t.Fatalf("candidates = %+v err %v (only the three subscription-category card payments qualify)", cands, err)
	}
	spend, err := fq.SpendingSince(ctx, forecastdb.SpendingSinceParams{UserID: id, Since: now.AddDate(0, 0, -100)})
	if err != nil || len(spend) != 5 { // 3 Netflix + food + transfer
		t.Fatalf("spending rows = %d err %v", len(spend), err)
	}
	salary, err := fq.SalaryCredits(ctx, forecastdb.SalaryCreditsParams{UserID: id, Since: now.AddDate(0, 0, -150)})
	if err != nil || len(salary) != 3 {
		t.Fatalf("salary rows = %d err %v", len(salary), err)
	}
	if created, err := fq.UserCreatedAt(ctx, id); err != nil || now.Sub(created) < 199*24*time.Hour {
		t.Fatalf("created %v err %v", created, err)
	}
	// The whole forecast over real rows: subscription found, then left out of daily spend.
	subs := forecast.Detect(id, []forecast.Charge{
		{ID: cands[0].ID, Merchant: cands[0].Merchant, Currency: cands[0].Currency, Amount: cands[0].AmountMinor, At: cands[0].CreatedAt},
		{ID: cands[1].ID, Merchant: cands[1].Merchant, Currency: cands[1].Currency, Amount: cands[1].AmountMinor, At: cands[1].CreatedAt},
		{ID: cands[2].ID, Merchant: cands[2].Merchant, Currency: cands[2].Currency, Amount: cands[2].AmountMinor, At: cands[2].CreatedAt},
	}, forecast.Day(now))
	if len(subs) != 1 || subs[0].Frequency != forecast.Monthly {
		t.Fatalf("subs = %+v", subs)
	}

	// Assistant queries.
	aq := assistantdb.New(pool)
	conv, err := aq.CreateConversation(ctx, assistantdb.CreateConversationParams{ID: uuid.New(), UserID: id})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := aq.GetConversation(ctx, assistantdb.GetConversationParams{ID: conv.ID, UserID: uuid.New()}); err == nil {
		t.Fatal("another customer read this conversation")
	}
	for i, role := range []string{"user", "assistant", "user"} {
		var ai []byte
		if role == "assistant" {
			ai = []byte(`{"feature":"assistant"}`)
		}
		if _, err := aq.InsertMessage(ctx, assistantdb.InsertMessageParams{ID: uuid.New(), ConversationID: conv.ID, UserID: id, Role: role, Blocks: []byte(`[]`), Ai: ai}); err != nil {
			t.Fatalf("message %d: %v", i, err)
		}
	}
	if _, err := aq.InsertMessage(ctx, assistantdb.InsertMessageParams{ID: uuid.New(), ConversationID: conv.ID, UserID: id, Role: "assistant", Blocks: []byte(`[]`)}); err == nil {
		t.Fatal("an assistant message without AI metadata must be refused")
	}
	rows, err := aq.ListMessages(ctx, assistantdb.ListMessagesParams{ConversationID: conv.ID, UserID: id, Lim: 2})
	if err != nil || len(rows) != 2 || rows[0].Role != "user" || rows[1].Role != "assistant" {
		t.Fatalf("first page = %+v err %v", rows, err)
	}
	next, err := aq.ListMessages(ctx, assistantdb.ListMessagesParams{ConversationID: conv.ID, UserID: id, AfterTime: rows[1].CreatedAt, AfterID: rows[1].ID, Lim: 5})
	if err != nil || len(next) != 1 || next[0].Role != "user" {
		t.Fatalf("second page = %+v err %v", next, err)
	}
	if n, _ := aq.CountSentSince(ctx, assistantdb.CountSentSinceParams{UserID: id, Since: now.Add(-time.Hour)}); n != 2 {
		t.Fatalf("sent = %d", n)
	}
	recent, _ := aq.RecentMessages(ctx, assistantdb.RecentMessagesParams{ConversationID: conv.ID, UserID: id, Lim: 10})
	if len(recent) != 3 || recent[0].ID != next[0].ID {
		t.Fatalf("recent should be newest first: %+v", recent)
	}

	act, err := aq.InsertAction(ctx, assistantdb.InsertActionParams{ID: uuid.New(), UserID: id, ConversationID: conv.ID, Kind: "card_freeze", Summary: "Freeze", Details: []byte(`{"card_id":"x"}`), ExpiresAt: now.Add(time.Hour)})
	if err != nil || act.Status != "prepared" {
		t.Fatalf("action %+v err %v", act, err)
	}
	if n, _ := aq.CountPendingActions(ctx, assistantdb.CountPendingActionsParams{UserID: id, Now: now}); n != 1 {
		t.Fatalf("pending = %d", n)
	}
	if n, _ := aq.DiscardAction(ctx, assistantdb.DiscardActionParams{ID: act.ID, UserID: uuid.New()}); n != 0 {
		t.Fatal("another customer discarded this action")
	}
	if n, _ := aq.DiscardAction(ctx, assistantdb.DiscardActionParams{ID: act.ID, UserID: id}); n != 1 {
		t.Fatal("the owner could not discard")
	}
	if n, _ := aq.DiscardAction(ctx, assistantdb.DiscardActionParams{ID: act.ID, UserID: id}); n != 0 {
		t.Fatal("a discarded action must not be discarded again")
	}

	cat, err := aq.SpendingByCategory(ctx, assistantdb.SpendingByCategoryParams{UserID: id, FromTime: now.AddDate(0, 0, -20), ToTime: now.Add(time.Hour)})
	if err != nil || len(cat) != 2 || cat[0].Category != "transfers" || cat[0].TotalMinor != 10_000_00 {
		t.Fatalf("categories = %+v err %v", cat, err)
	}
}
