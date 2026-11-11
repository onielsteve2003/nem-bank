package risk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"time"

	"github.com/google/uuid"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/risk/riskdb"
)

// Mode says what happens to the engine's answer.
type Mode string

const (
	// ModeEnforce acts on the decision: a step-up or hold stops the transfer.
	ModeEnforce Mode = "enforce"
	// ModeShadow scores and records every transfer but never stops one. It is how a new
	// model is watched against real traffic before it is allowed to block anything.
	ModeShadow Mode = "shadow"
)

// Label is a staff verdict on a scored transfer. Labels become training data.
type Label string

// The labels.
const (
	LabelFraud Label = "fraud"
	LabelLegit Label = "legit"
)

// ErrNotScored means the transfer has no assessment (it predates risk scoring, or was a duress look-alike).
var ErrNotScored = errors.New("risk: transfer was not scored")

// Config holds the service's dependencies.
type Config struct {
	// Engine scores; nil builds the real one and, if its model will not load, falls back to rules.
	Engine *Engine
	Mode   Mode // default ModeEnforce
	Logger *slog.Logger
	Now    func() time.Time
}

// Service gathers a transfer's features, scores them and keeps the record.
type Service struct {
	engine *Engine
	mode   Mode
	log    *slog.Logger
	now    func() time.Time
}

// NewService builds the service.
func NewService(cfg Config) (*Service, error) {
	if cfg.Logger == nil {
		return nil, errors.New("risk: logger is required")
	}
	if cfg.Mode == "" {
		cfg.Mode = ModeEnforce
	}
	if cfg.Mode != ModeEnforce && cfg.Mode != ModeShadow {
		return nil, fmt.Errorf("risk: unknown mode %q", cfg.Mode)
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Engine == nil {
		e, err := New()
		if err != nil {
			// The non-AI fallback (AI rule): a broken model must not stop transfers or let them all through.
			cfg.Logger.Error("risk model failed to load; rules decide alone", "error", err)
			e = RulesOnly()
		}
		cfg.Engine = e
	}
	return &Service{engine: cfg.Engine, mode: cfg.Mode, log: cfg.Logger, now: cfg.Now}, nil
}

// Mode reports whether decisions are enforced.
func (s *Service) Mode() Mode { return s.mode }

// Input is one transfer about to be created.
type Input struct {
	UserID uuid.UUID
	// DeviceID is the calling device; uuid.Nil when unknown.
	DeviceID uuid.UUID
	// BeneficiaryKey identifies who is paid, stable across saved and unsaved payees.
	BeneficiaryKey string
	AmountMinor    int64
	// BalanceMinor is the source account's ledger balance before the transfer.
	BalanceMinor int64
}

// Result is the assessment plus what to do about it now.
type Result struct {
	Assessment
	// Enforced is the decision to act on: the engine's in enforce mode, always Allow in shadow mode.
	Enforced Decision
	Mode     Mode
	Features Features
	input    Input
}

// wat is Lagos time (UTC+1, no daylight saving): the model's hour_of_day is Lagos time.
var wat = time.FixedZone("WAT", 3600)

const minHistoryForZScore = 5

// stdFloor stops a short, steady history giving an absurd z-score (log space).
const stdFloor = 0.25

// Evaluate gathers the features from the customer's earlier activity and scores the transfer.
// It only reads, and must run before the transfer row exists so the transfer is not counted
// against itself.
func (s *Service) Evaluate(ctx context.Context, db riskdb.DBTX, in Input) (Result, error) {
	at := s.now()
	q := riskdb.New(db)
	sig, err := q.Signals(ctx, riskdb.SignalsParams{UserID: in.UserID, At: at})
	if err != nil {
		return Result{}, fmt.Errorf("risk signals: %w", err)
	}
	knownBeneficiary, err := q.KnowsBeneficiary(ctx, riskdb.KnowsBeneficiaryParams{UserID: in.UserID, BeneficiaryKey: in.BeneficiaryKey})
	if err != nil {
		return Result{}, fmt.Errorf("risk beneficiary: %w", err)
	}
	f := Features{
		Velocity1h: float64(sig.LastHour), Velocity24h: float64(sig.LastDay), PriorCount: float64(sig.PriorCount),
		AmountZScore: math.NaN(), NewDevice: math.NaN(), AccountAgeDays: math.NaN(),
		HourOfDay: float64(at.In(wat).Hour()),
	}
	amountNGN := float64(in.AmountMinor) / 100
	f.AmountNGN, f.LogAmount = amountNGN, math.Log1p(amountNGN)
	if in.BalanceMinor > 0 {
		f.AmountToBalance = math.Min(float64(in.AmountMinor)/float64(in.BalanceMinor), 5)
	} else {
		f.AmountToBalance = 5
	}
	if sig.PriorCount >= minHistoryForZScore {
		n := float64(sig.PriorCount)
		mean := sig.SumLog / n
		std := math.Sqrt(math.Max(sig.SumLogSq/n-mean*mean, 0))
		f.AmountZScore = (f.LogAmount - mean) / math.Max(std, stdFloor)
	}
	if !knownBeneficiary {
		f.NewBeneficiary = 1
	}
	if in.DeviceID != uuid.Nil {
		known, err := q.KnowsDevice(ctx, riskdb.KnowsDeviceParams{UserID: in.UserID, DeviceID: &in.DeviceID})
		if err != nil {
			return Result{}, fmt.Errorf("risk device: %w", err)
		}
		// A customer's very first device is not "new": there is nothing to compare it to.
		if sig.PriorCount > 0 {
			f.NewDevice = b2f(!known)
		} else {
			f.NewDevice = 0
		}
	}
	if since, err := q.CustomerSince(ctx, in.UserID); err == nil {
		f.AccountAgeDays = math.Max(at.Sub(since).Hours()/24, 0) // clock skew must not make an account "younger than new"
	}

	a := s.engine.Assess(f)
	enforced := a.Decision
	if s.mode == ModeShadow {
		enforced = Allow
	}
	return Result{Assessment: a, Enforced: enforced, Mode: s.mode, Features: f, input: in}, nil
}

func b2f(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

// Contract is the assessment as the transfer shows it (contract RiskAssessment).
func (r Result) Contract() ([]byte, error) {
	return json.Marshal(map[string]any{
		"decision": r.Decision, "score": r.Score, "model_version": r.ModelVersion, "reasons": r.Reasons,
	})
}

// Record stores the assessment for a transfer that now exists, in the caller's transaction.
func (s *Service) Record(ctx context.Context, db riskdb.DBTX, transferID uuid.UUID, r Result) error {
	reasons, err := json.Marshal(r.Reasons)
	if err != nil {
		return fmt.Errorf("risk reasons: %w", err)
	}
	features, err := json.Marshal(r.Features)
	if err != nil {
		return fmt.Errorf("risk features: %w", err)
	}
	var device *uuid.UUID
	if r.input.DeviceID != uuid.Nil {
		device = &r.input.DeviceID
	}
	if err := riskdb.New(db).InsertAssessment(ctx, riskdb.InsertAssessmentParams{
		TransferID: transferID, UserID: r.input.UserID, DeviceID: device, BeneficiaryKey: r.input.BeneficiaryKey,
		Mode: string(r.Mode), ModelVersion: r.ModelVersion, ModelUsed: r.ModelUsed, Score: r.Score, RulesScore: r.RulesScore,
		Decision: string(r.Decision), Enforced: string(r.Enforced), Reasons: reasons, Features: features,
		DurationUs: r.Duration.Microseconds(),
	}); err != nil {
		return fmt.Errorf("record risk assessment: %w", err)
	}
	s.log.InfoContext(ctx, "transfer scored", "transfer_id", transferID, "decision", r.Decision, "enforced", r.Enforced,
		"score", r.Score, "model_used", r.ModelUsed, "mode", r.Mode, "took_us", r.Duration.Microseconds())
	return nil
}

// Label records a staff verdict on a scored transfer (fraud or legit). Labels feed retraining.
func (s *Service) Label(ctx context.Context, db riskdb.DBTX, transferID, staffID uuid.UUID, label Label, note string) error {
	if label != LabelFraud && label != LabelLegit {
		return fmt.Errorf("risk: label %q is not fraud or legit", label)
	}
	verdict := string(label)
	var n *string
	if note != "" {
		n = &note
	}
	rows, err := riskdb.New(db).LabelAssessment(ctx, riskdb.LabelAssessmentParams{
		TransferID: transferID, Label: &verdict, LabeledBy: &staffID, LabelNote: n,
	})
	if err != nil {
		return fmt.Errorf("label assessment: %w", err)
	}
	if rows == 0 {
		return ErrNotScored
	}
	return nil
}

// ExportLabeled writes the labelled transfers as JSON lines, one per transfer: the features
// the model saw, its score and decision, and the staff label. `nemml` reads this to retrain.
func (s *Service) ExportLabeled(ctx context.Context, db riskdb.DBTX, w io.Writer) (int, error) {
	rows, err := riskdb.New(db).ListLabeled(ctx)
	if err != nil {
		return 0, fmt.Errorf("list labelled: %w", err)
	}
	enc := json.NewEncoder(w)
	for _, r := range rows {
		line := map[string]any{
			"transfer_id": r.TransferID, "features": json.RawMessage(r.Features), "score": r.Score,
			"decision": r.Decision, "label": r.Label, "scored_at": r.CreatedAt,
		}
		if err := enc.Encode(line); err != nil {
			return 0, fmt.Errorf("write labelled: %w", err)
		}
	}
	return len(rows), nil
}
