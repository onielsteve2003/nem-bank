package transfers

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/risk"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/risk/riskdb"
)

func newRiskFixture(t *testing.T, mode risk.Mode) (*fixture, *risk.Service) {
	t.Helper()
	return newRiskFixtureWith(t, risk.Config{Mode: mode})
}

func newRiskFixtureWith(t *testing.T, cfg risk.Config) (*fixture, *risk.Service) {
	t.Helper()
	cfg.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	rs, err := risk.NewService(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return newFixtureWith(t, func(c *Config) {
		c.Risk, c.StepUps = rs, stepUps{}
		if cfg.Now != nil {
			c.Now = cfg.Now
		}
	}), rs
}

// A brand-new account sending most of its balance to someone it has never paid is what the
// rules exist for: it must be stopped, with reasons, and the money must stay put.
func TestRiskyTransferIsStoppedWithReasons(t *testing.T) {
	t.Parallel()
	f, _ := newRiskFixture(t, risk.ModeEnforce)
	tolu := f.customer("Tolu", "tolu", 10_000_000)
	ada := f.customer("Ada", "ada", 0)

	v, err := f.svc.Create(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(9_000_000), Narration: "Rent"})
	if err != nil {
		t.Fatal(err)
	}
	if v.Status != string(PendingStepUp) && v.Status != string(HeldForReview) {
		t.Fatalf("status %s, want pending_step_up or held_for_review: %v", v.Status, statuses(v))
	}
	if f.balance(ada) != 0 {
		t.Fatal("money moved while the transfer was stopped")
	}
	var r struct {
		Decision string `json:"decision"`
		Reasons  []struct{ Code, Message, Severity string }
	}
	if err := json.Unmarshal(v.Risk, &r); err != nil {
		t.Fatalf("risk on the transfer: %v", err)
	}
	if r.Decision == "allow" || len(r.Reasons) == 0 {
		t.Fatalf("risk = %s", v.Risk)
	}
	row, err := riskdb.New(f.pool).GetAssessment(t.Context(), v.ID)
	if err != nil {
		t.Fatal(err)
	}
	if row.Enforced != r.Decision || row.Mode != "enforce" || !row.ModelUsed || row.DurationUs > 10_000 {
		t.Fatalf("assessment row = %+v", row)
	}
}

// The rules alone (the non-AI fallback) ask for a step-up on a first, sizeable payment from a
// new account: 55 points, past the step-up line and short of the hold line.
func TestRulesOnlyFallbackAsksForStepUpThenSends(t *testing.T) {
	t.Parallel()
	f, _ := newRiskFixtureWith(t, risk.Config{Engine: risk.RulesOnly()})
	tolu := f.customer("Tolu", "tolu", 100_000_000)
	ada := f.customer("Ada", "ada", 0)
	req := Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(6_000_000), Narration: "Rent"}
	v, err := f.svc.Create(tolu.ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if v.Status != string(PendingStepUp) {
		t.Fatalf("status %s, want pending_step_up: %s", v.Status, v.Risk)
	}
	if f.balance(ada) != 0 {
		t.Fatal("money moved before the step-up")
	}
	done, err := f.svc.StepUp(tolu.ctx, v.ID, "ok")
	if err != nil {
		t.Fatal(err)
	}
	if done.Status != "completed" || f.balance(ada) == 0 {
		t.Fatalf("after step-up: %s, ada has %d", done.Status, f.balance(ada))
	}
	// With the confirmation already on the request, the same payment goes straight through.
	req.StepUpToken = "ok"
	again, err := f.svc.Create(tolu.ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if again.Status != "completed" {
		t.Fatalf("with a token: %s", again.Status)
	}
}

// A hold is not cleared by the customer's confirmation: only a person can clear it.
func TestStepUpTokenDoesNotClearAHold(t *testing.T) {
	t.Parallel()
	f, _ := newRiskFixtureWith(t, risk.Config{Engine: risk.RulesOnly()})
	tolu := f.customer("Tolu", "tolu", 10_000_000)
	ada := f.customer("Ada", "ada", 0)
	// New account, new payee, large, draining: 20+20+15+25 = 80 ... plus velocity makes 105+.
	v, err := f.svc.Create(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(9_000_000), Narration: "Rent", StepUpToken: "ok"})
	if err != nil {
		t.Fatal(err)
	}
	var r struct{ Decision string }
	_ = json.Unmarshal(v.Risk, &r)
	if r.Decision == "hold" && v.Status != string(HeldForReview) {
		t.Fatalf("hold with a token: %s", v.Status)
	}
	if r.Decision == "step_up" && v.Status != "completed" {
		t.Fatalf("step-up with a token: %s", v.Status)
	}
}

// Shadow mode records what the engine would have done and stops nothing.
func TestShadowModeScoresButNeverStops(t *testing.T) {
	t.Parallel()
	f, _ := newRiskFixture(t, risk.ModeShadow)
	tolu := f.customer("Tolu", "tolu", 10_000_000)
	ada := f.customer("Ada", "ada", 0)
	v, err := f.svc.Create(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(9_000_000), Narration: "Rent"})
	if err != nil {
		t.Fatal(err)
	}
	if v.Status != "completed" {
		t.Fatalf("shadow mode stopped a transfer: %s", v.Status)
	}
	row, err := riskdb.New(f.pool).GetAssessment(t.Context(), v.ID)
	if err != nil {
		t.Fatal(err)
	}
	if row.Decision == "allow" || row.Enforced != "allow" || row.Mode != "shadow" {
		t.Fatalf("shadow row = %+v", row)
	}
}

func TestEverydayTransferIsNotInterrupted(t *testing.T) {
	t.Parallel()
	clock := &clockFixture{now: time.Now()}
	f, _ := newRiskFixtureWith(t, risk.Config{Now: func() time.Time { clock.mu.Lock(); defer clock.mu.Unlock(); return clock.now }})
	tolu := f.customer("Tolu", "tolu", 50_000_000)
	ada := f.customer("Ada", "ada", 0)
	// A customer of a year, not of a minute: account age is a feature.
	if _, err := f.pool.Exec(t.Context(), `UPDATE users SET created_at = now() - interval '400 days' WHERE id = $1`, tolu.id); err != nil {
		t.Fatal(err)
	}
	// A week of small payments to the same person, then another of the same kind.
	for range 7 {
		clock.advance(26 * time.Hour)
		v, err := f.svc.Create(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(300_000), Narration: "Lunch"})
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("%s %s", v.Status, v.Risk)
	}
	last, err := f.svc.Create(tolu.ctx, Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(300_000), Narration: "Lunch"})
	if err != nil {
		t.Fatal(err)
	}
	if last.Status != "completed" {
		t.Fatalf("an ordinary repeat payment was stopped: %s %s", last.Status, last.Risk)
	}
}

// The second payment to the same person is not "new", and the same device is not "new".
func TestRepeatPayeeAndDeviceAreNotNew(t *testing.T) {
	t.Parallel()
	f, rs := newRiskFixture(t, risk.ModeShadow)
	tolu := f.customer("Tolu", "tolu", 50_000_000)
	ada := f.customer("Ada", "ada", 0)
	device := uuid.New()
	ctx := identity.WithPrincipal(tolu.ctx, identity.Principal{UserID: tolu.id, DeviceID: device})
	var ids []uuid.UUID
	for range 2 {
		v, err := f.svc.Create(ctx, Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(100_000), Narration: "Lunch"})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, v.ID)
	}
	feats := func(id uuid.UUID) map[string]*float64 {
		row, err := riskdb.New(f.pool).GetAssessment(t.Context(), id)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]*float64
		if err := json.Unmarshal(row.Features, &m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	first, second := feats(ids[0]), feats(ids[1])
	if *first["new_beneficiary"] != 1 || *second["new_beneficiary"] != 0 {
		t.Fatalf("new_beneficiary: first %v, second %v", *first["new_beneficiary"], *second["new_beneficiary"])
	}
	if *first["new_device"] != 0 || *second["new_device"] != 0 {
		t.Fatalf("a customer's own device flagged new: %v, %v", *first["new_device"], *second["new_device"])
	}
	if *second["prior_count"] != 1 {
		t.Fatalf("prior_count = %v", *second["prior_count"])
	}
	// Another device, after history exists, is new.
	other := identity.WithPrincipal(tolu.ctx, identity.Principal{UserID: tolu.id, DeviceID: uuid.New()})
	v, err := f.svc.Create(other, Request{SourceAccountID: tolu.account, Destination: toNem(ada.number), Amount: ngn(100_000), Narration: "Lunch"})
	if err != nil {
		t.Fatal(err)
	}
	if *feats(v.ID)["new_device"] != 1 {
		t.Fatal("a second device was not flagged new")
	}

	// Staff labels become training rows.
	staff := uuid.New()
	if err := rs.Label(t.Context(), f.pool, v.ID, staff, risk.LabelLegit, "customer rang to confirm"); err != nil {
		t.Fatal(err)
	}
	if err := rs.Label(t.Context(), f.pool, uuid.New(), staff, risk.LabelFraud, ""); err == nil {
		t.Fatal("labelled a transfer that was never scored")
	}
	if err := rs.Label(t.Context(), f.pool, v.ID, staff, "maybe", ""); err == nil {
		t.Fatal("accepted a label that is neither fraud nor legit")
	}
	var out bytes.Buffer
	n, err := rs.ExportLabeled(t.Context(), f.pool, &out)
	if err != nil || n != 1 {
		t.Fatalf("export: %d rows, %v", n, err)
	}
	var line map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(out.Bytes()), &line); err != nil {
		t.Fatal(err)
	}
	if line["label"] != "legit" || !strings.Contains(out.String(), `"log_amount"`) {
		t.Fatalf("export line = %s", out.String())
	}
}
