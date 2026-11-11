package console

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/admin"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/console/consoledb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/fx"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/limits"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// The bank's configuration (ADM-8) is one versioned document. A change to a section is proposed
// against a version and goes through maker-checker; approving it applies the change to the
// live limits engine and FX service without a restart.
//
// What is live: fees (external bands, EMTL), tier limits and balance caps, the new-beneficiary
// cooling-off and FX spreads. What is stored but not live: the new-device cool-off (an identity
// constant today) and the internal transfer fee (Nem to Nem is free by rule, so only zero is
// accepted).

var errStaleConfig = problem.Conflict("The configuration changed since you opened it. Reload it and make the change again.")

func ngn(minor int64) api.Money { return accounts.Money(money.New(minor, money.NGN)) }

func majorMinor(m api.Money) (int64, error) {
	v, err := money.ParseMinor(m.AmountMinor, string(m.Currency))
	if err != nil || v.Currency() != money.NGN {
		return 0, errors.New("amount must be naira")
	}
	return v.Amount(), nil
}

// defaultConfig is the document the bank starts with: the limits engine's rules, the FX
// service's default spread and the new-device rule.
func defaultConfig(r limits.Rules) api.BankConfig {
	var c api.BankConfig
	c.Fees.InternalTransfer = ngn(0)
	c.Fees.Emtl, c.Fees.EmtlThreshold = ngn(r.EMTLMinor), ngn(r.EMTLThresholdMinor)
	for _, b := range r.ExternalBands {
		band := api.FeeBand{Fee: ngn(b.FeeMinor)}
		if b.UpToMinor > 0 {
			u := ngn(b.UpToMinor)
			band.UpTo = &u
		}
		c.Fees.ExternalTransferBands = append(c.Fees.ExternalTransferBands, band)
	}
	for _, tier := range []int{1, 2, 3} {
		t := r.Tier(tier)
		tl := api.TierLimit{Tier: api.KycTier(tier), DailyLimit: ngn(t.DailyMinor)}
		if t.MaxBalanceMinor > 0 {
			m := ngn(t.MaxBalanceMinor)
			tl.MaxBalance = &m
		}
		c.Limits = append(c.Limits, tl)
	}
	c.FxSpreadsBps = map[string]api.BasisPoints{"USD-NGN": fx.DefaultSpreadBPS, "GBP-NGN": fx.DefaultSpreadBPS, "EUR-NGN": fx.DefaultSpreadBPS}
	c.CoolingOff.NewBeneficiaryThreshold = ngn(r.CoolingOffThresholdMinor)
	c.CoolingOff.DelayMinutes = int(r.CoolingOffDelay / time.Minute)
	c.NewDevice.CoolOffHours = 24
	c.NewDevice.DailyLimit = ngn(50_000 * 100)
	return c
}

// currentConfig loads the document, seeding it on first use.
func (s *Service) currentConfig(ctx context.Context) (api.BankConfig, error) {
	row, err := s.q.GetBankConfig(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		raw, merr := json.Marshal(defaultConfig(s.limits.Rules()))
		if merr != nil {
			return api.BankConfig{}, fmt.Errorf("encode default config: %w", merr)
		}
		if err := s.q.SeedBankConfig(ctx, raw); err != nil {
			return api.BankConfig{}, fmt.Errorf("seed config: %w", err)
		}
		row, err = s.q.GetBankConfig(ctx)
	}
	if err != nil {
		return api.BankConfig{}, fmt.Errorf("load config: %w", err)
	}
	return decodeConfig(row.Value, int(row.Version), row.UpdatedAt)
}

func decodeConfig(raw []byte, version int, at time.Time) (api.BankConfig, error) {
	var c api.BankConfig
	if err := json.Unmarshal(raw, &c); err != nil {
		return api.BankConfig{}, fmt.Errorf("decode config: %w", err)
	}
	c.Version, c.UpdatedAt = version, at.UTC()
	return c, nil
}

// BankConfig is GET /v1/admin/config.
func (s *Service) BankConfig(ctx context.Context) (api.BankConfig, error) {
	if _, err := staff(ctx); err != nil {
		return api.BankConfig{}, err
	}
	return s.currentConfig(ctx)
}

// ApplyLive pushes the stored configuration into the running services. It runs at start-up too,
// so a restart keeps what staff approved.
func (s *Service) ApplyLive(ctx context.Context) error {
	c, err := s.currentConfig(ctx)
	if err != nil {
		return err
	}
	return s.applyConfig(c)
}

func (s *Service) applyConfig(c api.BankConfig) error {
	r := s.limits.Rules()
	tiers := map[int]limits.Tier{}
	for _, t := range c.Limits {
		d, err := majorMinor(t.DailyLimit)
		if err != nil {
			return err
		}
		tier := limits.Tier{DailyMinor: d}
		if t.MaxBalance != nil {
			if tier.MaxBalanceMinor, err = majorMinor(*t.MaxBalance); err != nil {
				return err
			}
		}
		tiers[int(t.Tier)] = tier
	}
	r.Tiers = tiers
	r.ExternalBands = r.ExternalBands[:0:0]
	for _, b := range c.Fees.ExternalTransferBands {
		fee, err := majorMinor(b.Fee)
		if err != nil {
			return err
		}
		band := limits.FeeBand{FeeMinor: fee}
		if b.UpTo != nil {
			if band.UpToMinor, err = majorMinor(*b.UpTo); err != nil {
				return err
			}
		}
		r.ExternalBands = append(r.ExternalBands, band)
	}
	var err error
	if r.EMTLMinor, err = majorMinor(c.Fees.Emtl); err != nil {
		return err
	}
	if r.EMTLThresholdMinor, err = majorMinor(c.Fees.EmtlThreshold); err != nil {
		return err
	}
	if r.CoolingOffThresholdMinor, err = majorMinor(c.CoolingOff.NewBeneficiaryThreshold); err != nil {
		return err
	}
	r.CoolingOffDelay = time.Duration(c.CoolingOff.DelayMinutes) * time.Minute
	s.limits.SetRules(r)
	return s.fx.SetSpreads(c.FxSpreadsBps)
}

var configSections = []string{"fees", "limits", "fx_spreads_bps", "cooling_off", "new_device"}

// withSection returns c with one section replaced by raw (the section's full new value),
// checked for sense. Unknown fields are refused so a typo cannot silently do nothing.
func withSection(c api.BankConfig, section string, raw json.RawMessage) (api.BankConfig, any, error) {
	bad := func(field, msg string) (api.BankConfig, any, error) {
		return c, nil, problem.Validation(problem.Field("/value"+field, "invalid", msg))
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	switch section {
	case "fees":
		if err := dec.Decode(&c.Fees); err != nil {
			return bad("", "That is not a valid fees section.")
		}
		if v, err := majorMinor(c.Fees.InternalTransfer); err != nil || v != 0 {
			return bad("/internal_transfer", "Nem to Nem transfers are free; this must be zero.")
		}
		em, e1 := majorMinor(c.Fees.Emtl)
		th, e2 := majorMinor(c.Fees.EmtlThreshold)
		if e1 != nil || e2 != nil || em < 0 || th < 0 {
			return bad("/emtl", "Levy amounts must be naira, zero or more.")
		}
		if msg := checkBands(c.Fees.ExternalTransferBands); msg != "" {
			return bad("/external_transfer_bands", msg)
		}
		return c, c.Fees, nil
	case "limits":
		if err := dec.Decode(&c.Limits); err != nil {
			return bad("", "That is not a valid limits section.")
		}
		if msg := checkTiers(c.Limits); msg != "" {
			return bad("", msg)
		}
		return c, c.Limits, nil
	case "fx_spreads_bps":
		spreads := map[string]api.BasisPoints{}
		if err := dec.Decode(&spreads); err != nil {
			return bad("", "That is not a valid spreads section.")
		}
		for pair, bps := range spreads {
			base, quote, ok := strings.Cut(pair, "-")
			if !ok || quote != "NGN" || !slices.Contains([]string{"USD", "GBP", "EUR"}, base) {
				return bad("/"+pair, "Use a pair like USD-NGN.")
			}
			if bps < 0 || bps > 2000 {
				return bad("/"+pair, "A spread must be between 0 and 2,000 basis points.")
			}
		}
		c.FxSpreadsBps = spreads
		return c, spreads, nil
	case "cooling_off":
		if err := dec.Decode(&c.CoolingOff); err != nil {
			return bad("", "That is not a valid cooling-off section.")
		}
		if v, err := majorMinor(c.CoolingOff.NewBeneficiaryThreshold); err != nil || v < 0 {
			return bad("/new_beneficiary_threshold", "The threshold must be naira, zero or more.")
		}
		if c.CoolingOff.DelayMinutes < 1 || c.CoolingOff.DelayMinutes > 24*60 {
			return bad("/delay_minutes", "The delay must be 1 to 1,440 minutes.")
		}
		return c, c.CoolingOff, nil
	case "new_device":
		if err := dec.Decode(&c.NewDevice); err != nil {
			return bad("", "That is not a valid new-device section.")
		}
		if v, err := majorMinor(c.NewDevice.DailyLimit); err != nil || v <= 0 {
			return bad("/daily_limit", "The daily limit must be naira above zero.")
		}
		if c.NewDevice.CoolOffHours < 1 || c.NewDevice.CoolOffHours > 168 {
			return bad("/cool_off_hours", "The cool-off must be 1 to 168 hours.")
		}
		return c, c.NewDevice, nil
	}
	return bad("", "Unknown section.")
}

// checkBands: ascending upper bounds, the last band open, no negative fee.
func checkBands(bands []api.FeeBand) string {
	if len(bands) == 0 || len(bands) > 10 {
		return "Give 1 to 10 fee bands."
	}
	prev := int64(0)
	for i, b := range bands {
		fee, err := majorMinor(b.Fee)
		if err != nil || fee < 0 {
			return "Fees must be naira, zero or more."
		}
		last := i == len(bands)-1
		if last != (b.UpTo == nil) {
			return "Only the last band has no upper bound."
		}
		if b.UpTo != nil {
			up, err := majorMinor(*b.UpTo)
			if err != nil || up <= prev {
				return "Band upper bounds must go up."
			}
			prev = up
		}
	}
	return ""
}

// checkTiers: tiers 1 to 3 once each, a positive daily limit, limits that never go down as the
// tier goes up, and a balance cap (where there is one) no smaller than the daily limit.
func checkTiers(ts []api.TierLimit) string {
	if len(ts) != 3 {
		return "Give limits for tiers 1, 2 and 3."
	}
	byTier := map[int]api.TierLimit{}
	for _, t := range ts {
		byTier[int(t.Tier)] = t
	}
	prev := int64(0)
	for tier := 1; tier <= 3; tier++ {
		t, ok := byTier[tier]
		if !ok {
			return "Give limits for tiers 1, 2 and 3."
		}
		d, err := majorMinor(t.DailyLimit)
		if err != nil || d <= 0 {
			return "Daily limits must be naira above zero."
		}
		if d < prev {
			return "A higher tier cannot have a lower daily limit."
		}
		prev = d
		if t.MaxBalance != nil {
			mb, err := majorMinor(*t.MaxBalance)
			if err != nil || mb < d {
				return "A balance cap cannot be below the daily limit."
			}
		}
	}
	return ""
}

// RequestConfigChange proposes replacing one section of the configuration (maker-checker).
func (s *Service) RequestConfigChange(ctx context.Context, req api.ConfigChangeRequest) (api.ApprovalRequest, error) {
	if _, err := staff(ctx); err != nil {
		return api.ApprovalRequest{}, err
	}
	if !slices.Contains(configSections, string(req.Section)) {
		return api.ApprovalRequest{}, problem.Validation(problem.Field("/section", "invalid", "Choose fees, limits, fx_spreads_bps, cooling_off or new_device."))
	}
	cur, err := s.currentConfig(ctx)
	if err != nil {
		return api.ApprovalRequest{}, err
	}
	if req.BaseVersion != cur.Version {
		return api.ApprovalRequest{}, errStaleConfig
	}
	_, after, err := withSection(cur, string(req.Section), req.Value)
	if err != nil {
		return api.ApprovalRequest{}, err
	}
	_, before, _ := withSection(cur, string(req.Section), mustJSON(sectionOf(cur, string(req.Section))))
	return s.propose(ctx, admin.Proposal{
		Action: admin.ActionConfigChange, Reason: req.Reason, Summary: "Change " + string(req.Section) + " configuration",
		Before: map[string]any{"section": string(req.Section), "base_version": cur.Version, "value": before},
		After:  map[string]any{"section": string(req.Section), "base_version": cur.Version, "value": after},
	})
}

func sectionOf(c api.BankConfig, section string) any {
	switch section {
	case "fees":
		return c.Fees
	case "limits":
		return c.Limits
	case "fx_spreads_bps":
		return c.FxSpreadsBps
	case "cooling_off":
		return c.CoolingOff
	default:
		return c.NewDevice
	}
}

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return b
}

// applyConfigChange carries out an approved change inside the approval's transaction: against
// the version it was proposed on, then live in the running services.
func (s *Service) applyConfigChange(ctx context.Context, tx pgx.Tx, a admin.Approval) (admin.Effect, error) {
	in, err := decodeAfter[struct {
		Section     string          `json:"section"`
		BaseVersion int32           `json:"base_version"`
		Value       json.RawMessage `json:"value"`
	}](a)
	if err != nil {
		return admin.Effect{}, err
	}
	q := s.q.WithTx(tx)
	row, err := q.GetBankConfig(ctx)
	if err != nil {
		return admin.Effect{}, fmt.Errorf("load config: %w", err)
	}
	cur, err := decodeConfig(row.Value, int(row.Version), row.UpdatedAt)
	if err != nil {
		return admin.Effect{}, err
	}
	next, _, err := withSection(cur, in.Section, in.Value)
	if err != nil {
		return admin.Effect{}, err
	}
	raw, err := json.Marshal(next)
	if err != nil {
		return admin.Effect{}, fmt.Errorf("encode config: %w", err)
	}
	if _, err := q.ApplyBankConfig(ctx, consoledb.ApplyBankConfigParams{Value: raw, Now: s.now(), BaseVersion: in.BaseVersion}); errors.Is(err, pgx.ErrNoRows) {
		return admin.Effect{}, errStaleConfig
	} else if err != nil {
		return admin.Effect{}, fmt.Errorf("apply config: %w", err)
	}
	// The services change before the transaction commits. If the commit then fails the
	// next start-up restores the stored document, so the worst case is a brief difference.
	if err := s.applyConfig(next); err != nil {
		return admin.Effect{}, fmt.Errorf("apply live config: %w", err)
	}
	return admin.Effect{AuditAction: "config.change", ResourceType: "bank_config", ResourceID: in.Section}, nil
}

// decodeAfter reads an approval's After diff into a typed value.
func decodeAfter[T any](a admin.Approval) (T, error) {
	var v T
	raw, err := json.Marshal(a.After)
	if err != nil {
		return v, fmt.Errorf("encode approval diff: %w", err)
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		return v, fmt.Errorf("decode approval diff: %w", err)
	}
	return v, nil
}

// ---------------------------------------------------------------- feature flags

// FeatureFlags lists every flag.
func (s *Service) FeatureFlags(ctx context.Context) ([]api.FeatureFlag, error) {
	if _, err := staff(ctx); err != nil {
		return nil, err
	}
	rows, err := s.q.ListFeatureFlags(ctx)
	if err != nil {
		return nil, fmt.Errorf("list flags: %w", err)
	}
	out := make([]api.FeatureFlag, len(rows))
	for i, r := range rows {
		out[i] = api.FeatureFlag{Key: r.Key, Description: r.Description, Enabled: r.Enabled, PaidFeature: r.PaidFeature, UpdatedAt: r.UpdatedAt.UTC()}
		if r.UpdatedBy != nil && r.UpdatedByName != nil {
			out[i].UpdatedBy = &api.StaffRef{Id: *r.UpdatedBy, Name: *r.UpdatedByName}
		}
	}
	return out, nil
}

// PaidFeatureConnected reports whether a paid feature has an adapter behind it. None does in v1
// (PRD §11), so a paid flag cannot be switched on: there is nothing to run it.
func PaidFeatureConnected(string) bool { return false }

// SetFeatureFlag turns a flag on or off. A paid feature stays off until an adapter is connected.
func (s *Service) SetFeatureFlag(ctx context.Context, key string, enabled bool, reason string) (api.FeatureFlag, error) {
	p, err := staff(ctx)
	if err != nil {
		return api.FeatureFlag{}, err
	}
	if utf8.RuneCountInString(reason) > 500 {
		return api.FeatureFlag{}, admin.ErrBadReason
	}
	err = s.inTx(ctx, func(tx pgx.Tx, q *consoledb.Queries) error {
		f, err := q.GetFeatureFlag(ctx, key)
		if errors.Is(err, pgx.ErrNoRows) {
			return problem.NotFound("Feature flag")
		}
		if err != nil {
			return fmt.Errorf("load flag: %w", err)
		}
		if enabled && f.PaidFeature && !PaidFeatureConnected(key) {
			return problem.Conflict("This feature needs a paid partner and none is connected, so it stays off.")
		}
		if f.Enabled == enabled {
			return nil
		}
		if err := q.SetFeatureFlag(ctx, consoledb.SetFeatureFlagParams{Key: key, Enabled: enabled, Now: s.now(), StaffID: &p.StaffID}); err != nil {
			return fmt.Errorf("set flag: %w", err)
		}
		return s.record(ctx, tx, actorOf(p), "feature_flag.set", "feature_flag", key, map[string]any{"enabled": enabled, "reason_given": reason != ""})
	})
	if err != nil {
		return api.FeatureFlag{}, err
	}
	flags, err := s.FeatureFlags(ctx)
	if err != nil {
		return api.FeatureFlag{}, err
	}
	for _, f := range flags {
		if f.Key == key {
			return f, nil
		}
	}
	return api.FeatureFlag{}, problem.NotFound("Feature flag")
}

// FlagEnabled reports whether a flag is on; an unknown flag is off.
func (s *Service) FlagEnabled(ctx context.Context, key string) (bool, error) {
	f, err := s.q.GetFeatureFlag(ctx, key)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return f.Enabled, err
}

var _ = uuid.Nil
