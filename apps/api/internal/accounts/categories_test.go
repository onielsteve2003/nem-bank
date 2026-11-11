package accounts

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
)

// card records a pending card payment, as the card processor does at authorization.
func (f *fixture) card(user uuid.UUID, merchant, category, source string, confidence *float64) uuid.UUID {
	f.t.Helper()
	ctx := f.t.Context()
	var account uuid.UUID
	if err := f.pool.QueryRow(ctx, `SELECT account_id FROM customer_accounts WHERE user_id = $1`, user).Scan(&account); err != nil {
		f.t.Fatal(err)
	}
	var id uuid.UUID
	err := pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		t, err := Record(ctx, tx, Line{
			UserID: user, AccountID: account, Type: "card_payment", Direction: "debit", Status: "pending", Amount: ngn(250_000),
			Narration: merchant, Reference: "REF" + uuid.NewString()[:8], Category: category, CategorySource: source,
			CategoryConfidence: confidence, Counterparty: api.Counterparty{Name: merchant},
		})
		id = t.ID
		return err
	})
	if err != nil {
		f.t.Fatal(err)
	}
	return id
}

func (f *fixture) detail(ctx context.Context, id uuid.UUID) Detail {
	f.t.Helper()
	d, err := f.svc.Transaction(ctx, id)
	if err != nil {
		f.t.Fatal(err)
	}
	return d
}

func TestModelGuessCarriesItsConfidenceAndNothingElseDoes(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	ctx, user := f.customer()
	conf := 0.83
	guess := f.detail(ctx, f.card(user, "Adaobi Chemist", "health", "model", &conf))
	if guess.CategorySource != "model" || guess.CategoryConfidence == nil || *guess.CategoryConfidence < 0.82 || *guess.CategoryConfidence > 0.84 {
		t.Fatalf("model guess = %s %v", guess.CategorySource, guess.CategoryConfidence)
	}
	// A confidence on a line the rules filed is dropped: the database would refuse it otherwise.
	rules := f.detail(ctx, f.card(user, "Shoprite", "groceries", "rules", &conf))
	if rules.CategorySource != "rules" || rules.CategoryConfidence != nil {
		t.Fatalf("rules line = %s %v", rules.CategorySource, rules.CategoryConfidence)
	}
}

func TestCorrectionBeatsTheModelAndLearnsTheMerchant(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	ctx, user := f.customer()
	conf := 0.61
	first := f.card(user, "Bolt", "shopping", "model", &conf)
	second := f.card(user, "  BOLT ", "shopping", "model", &conf) // same merchant, different case and spacing
	other := f.card(user, "Netflix", "subscriptions", "rules", nil)

	got, err := f.svc.Recategorize(ctx, first, "transport", false)
	if err != nil {
		t.Fatal(err)
	}
	if got.Category != "transport" || got.CategorySource != "user" || got.CategoryConfidence != nil {
		t.Fatalf("corrected = %s %s %v", got.Category, got.CategorySource, got.CategoryConfidence)
	}
	// Only this payment so far.
	if d := f.detail(ctx, second); d.Category != "shopping" || d.CategorySource != "model" {
		t.Fatalf("a one-off correction changed another payment: %s %s", d.Category, d.CategorySource)
	}

	// "Always": the other Bolt payment changes now, another merchant does not, and the next
	// Bolt payment is filed the same way as it is recorded, whatever the model says.
	if _, err := f.svc.Recategorize(ctx, first, "transport", true); err != nil {
		t.Fatal(err)
	}
	if d := f.detail(ctx, second); d.Category != "transport" || d.CategorySource != "user" || d.CategoryConfidence != nil {
		t.Fatalf("similar payment = %s %s %v", d.Category, d.CategorySource, d.CategoryConfidence)
	}
	if d := f.detail(ctx, other); d.Category != "subscriptions" || d.CategorySource != "rules" {
		t.Fatalf("another merchant changed: %s %s", d.Category, d.CategorySource)
	}
	future := f.detail(ctx, f.card(user, "bolt", "entertainment", "model", &conf))
	if future.Category != "transport" || future.CategorySource != "user" || future.CategoryConfidence != nil {
		t.Fatalf("future payment = %s %s %v", future.Category, future.CategorySource, future.CategoryConfidence)
	}

	// Every correction is a labelled example for retraining.
	var out bytes.Buffer
	n, err := f.svc.ExportCorrections(t.Context(), &out)
	if err != nil || n != 2 {
		t.Fatalf("export: %d rows, %v", n, err)
	}
	var line map[string]any
	if err := json.Unmarshal([]byte(strings.SplitN(out.String(), "\n", 2)[0]), &line); err != nil {
		t.Fatal(err)
	}
	if line["text"] != "Bolt Bolt" || line["label"] != "transport" || line["previous"] != "shopping" || line["previous_source"] != "model" {
		t.Fatalf("first correction = %v", line)
	}
}

func TestCorrectionsAreRefusedForOthersAndForNonCategories(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	ctx, user := f.customer()
	otherCtx, _ := f.customer()
	id := f.card(user, "Bolt", "transport", "rules", nil)

	if _, err := f.svc.Recategorize(otherCtx, id, "food", true); err == nil {
		t.Fatal("someone else recategorized a transaction that is not theirs")
	}
	if _, err := f.svc.Recategorize(ctx, id, "gambling", false); err == nil {
		t.Fatal("accepted a category that does not exist")
	}
	if d := f.detail(ctx, id); d.Category != "transport" || d.CategorySource != "rules" {
		t.Fatalf("a refused correction changed the line: %s %s", d.Category, d.CategorySource)
	}
	// Another customer's rule for "Bolt" does not leak: they have none.
	if _, err := f.svc.Recategorize(ctx, id, "food", true); err != nil {
		t.Fatal(err)
	}
	other := f.card(mustUser(otherCtx, t), "Bolt", "transport", "rules", nil)
	if d := f.detail(otherCtx, other); d.Category != "transport" || d.CategorySource != "rules" {
		t.Fatalf("one customer's rule applied to another: %s %s", d.Category, d.CategorySource)
	}
}

func mustUser(ctx context.Context, t *testing.T) uuid.UUID {
	t.Helper()
	p, err := principal(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return p.UserID
}
