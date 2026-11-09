package partners

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/audit"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers/partners/partnersdb"
)

// Settings are the Bank Partner Simulator's knobs (contract BankPartnerSimulator).
type Settings struct {
	FailureRateBps  int       `json:"failure_rate_bps"`
	MinDelaySeconds int       `json:"min_delay_seconds"`
	MaxDelaySeconds int       `json:"max_delay_seconds"`
	NameCheck       NameCheck `json:"name_check"`
	TimeoutRateBps  int       `json:"timeout_rate_bps"`
}

// DefaultSettings are the console's defaults, also seeded by migration 00015.
var DefaultSettings = Settings{FailureRateBps: 200, MinDelaySeconds: 1, MaxDelaySeconds: 8, NameCheck: Realistic, TimeoutRateBps: 50}

const settingsName = "bank_partner"

// check is what the contract's ranges cannot say on their own (the console mock's rules).
func (s Settings) check() error {
	var fields []api.FieldError
	if s.MinDelaySeconds > s.MaxDelaySeconds {
		fields = append(fields, problem.Field("/max_delay_seconds", "out_of_range", "At least the shortest delay."))
	}
	if s.FailureRateBps+s.TimeoutRateBps > 10_000 {
		fields = append(fields, problem.Field("/timeout_rate_bps", "out_of_range",
			"Failures and timeouts add up to more than every transfer: together at most 10,000."))
	}
	if len(fields) > 0 {
		return problem.Validation(fields...)
	}
	return nil
}

// Settings reads the simulator's settings; without a database, the defaults.
func (s *SandboxNIP) Settings(ctx context.Context) (Settings, error) {
	if s.pool == nil {
		return DefaultSettings, nil
	}
	raw, err := partnersdb.New(s.pool).GetSimulatorSettings(ctx, settingsName)
	if err != nil {
		return Settings{}, fmt.Errorf("load simulator settings: %w", err)
	}
	out := DefaultSettings // a field added later keeps its default until staff set it
	if err := json.Unmarshal(raw, &out); err != nil {
		return Settings{}, fmt.Errorf("decode simulator settings: %w", err)
	}
	return out, nil
}

// SetSettings saves new settings and records who changed them in the audit log, in one
// transaction. Payments already received keep the outcome they were given.
func (s *SandboxNIP) SetSettings(ctx context.Context, staffID uuid.UUID, staffName string, in Settings) (Settings, error) {
	if err := in.check(); err != nil {
		return Settings{}, err
	}
	raw, err := json.Marshal(in)
	if err != nil {
		return Settings{}, fmt.Errorf("encode simulator settings: %w", err)
	}
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := partnersdb.New(tx).SetSimulatorSettings(ctx, partnersdb.SetSimulatorSettingsParams{
			Name: settingsName, Settings: raw, UpdatedBy: &staffID,
		}); err != nil {
			return fmt.Errorf("save simulator settings: %w", err)
		}
		id := staffID.String()
		_, err := audit.Append(ctx, tx, audit.Input{
			Actor:  audit.Actor{Type: audit.ActorStaff, ID: &id, Name: &staffName},
			Action: "simulator.bank_partner.update", ResourceType: "simulator", ResourceID: settingsName,
			Metadata: map[string]any{
				"failure_rate_bps": in.FailureRateBps, "timeout_rate_bps": in.TimeoutRateBps,
				"min_delay_seconds": in.MinDelaySeconds, "max_delay_seconds": in.MaxDelaySeconds, "name_check": string(in.NameCheck),
			},
		}, s.now())
		if err != nil {
			return fmt.Errorf("audit simulator change: %w", err)
		}
		return nil
	})
	if err != nil {
		return Settings{}, err
	}
	return in, nil
}
