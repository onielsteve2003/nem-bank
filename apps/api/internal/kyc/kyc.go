package kyc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/audit"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/kyc/kycdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/limits"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/fieldcrypt"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers/cop"
)

// Policy. Each number has a reason.
const (
	// identityAttemptsPerHour caps failed BVN/NIN checks: the number is a guessable 11 digits,
	// and a provider charges per lookup.
	identityAttemptsPerHour = 5
	// uploadsPerHour caps document uploads: every one stores an encrypted blob.
	uploadsPerHour = 20
)

// Problems.
var (
	errTier3Already  = problem.New(http.StatusConflict, "invalid_state", "You are already Tier 3")
	errTierRequired  = problem.New(http.StatusForbidden, "kyc_tier_required", "Verify your BVN or NIN first")
	errPendingReview = problem.New(http.StatusConflict, "invalid_state", "Your documents are being reviewed")
	// ErrSubmissionNotFound is the 404 for a submission the caller does not have.
	ErrSubmissionNotFound = problem.NotFound("Submission")
)

// Subject is what a provider needs to simulate a record: the sandbox answers with the
// customer's own details, as a real BVN record would hold.
type Subject struct {
	Name        string
	DateOfBirth time.Time
}

// Record is what the identity registry holds for a number.
type Record struct {
	Name        string
	DateOfBirth time.Time
}

// Provider looks up a BVN or NIN (the task's KycProvider). A real adapter ignores Subject.
type Provider interface {
	Name() string
	// Sandbox is true while only test numbers are accepted; the app labels the result.
	Sandbox() bool
	// Lookup returns the record for number, or found=false when there is none.
	Lookup(ctx context.Context, subject Subject, kind Kind, number string) (rec Record, found bool, err error)
}

// Sandbox is the default provider: free, offline and deterministic. Any 11-digit number
// belongs to the customer asking, except all zeros, which no record has, so a demo can show
// both outcomes.
type Sandbox struct{}

// Name implements Provider.
func (Sandbox) Name() string { return "sandbox" }

// Sandbox implements Provider.
func (Sandbox) Sandbox() bool { return true }

// Lookup implements Provider.
func (Sandbox) Lookup(_ context.Context, s Subject, _ Kind, number string) (Record, bool, error) {
	if strings.Trim(number, "0") == "" {
		return Record{}, false, nil
	}
	return Record(s), true, nil
}

// TierRules is where the tier limits come from.
type TierRules interface{ Rules() limits.Rules }

// Config holds the service's dependencies.
type Config struct {
	Pool        *pgxpool.Pool
	Identifiers *Identifiers
	Keyring     *fieldcrypt.Keyring
	Provider    Provider
	// Limits supplies the tier table (daily limit and balance cap) shown on the tiers screen;
	// *limits.Service implements it.
	Limits TierRules
	// Blobs stores document photos; defaults to the encrypted Postgres store.
	Blobs BlobStore
	// SampleHashes are the SHA-256 digests (hex) of the demo's bundled sample ID images. Only a
	// front-of-ID upload that matches one is flagged a sample, and only samples can be prefilled.
	SampleHashes []string
	Logger       *slog.Logger
	// Now defaults to time.Now.
	Now func() time.Time
}

// Service is the KYC domain: identity checks, documents, Tier 3 submissions and their review.
type Service struct {
	pool     *pgxpool.Pool
	q        *kycdb.Queries
	ids      *Identifiers
	keys     *fieldcrypt.Keyring
	provider Provider
	limits   TierRules
	blobs    BlobStore
	samples  map[string]bool
	log      *slog.Logger
	now      func() time.Time
	// afterSubmit runs once a Tier 3 submission is stored; see SetAfterSubmit.
	afterSubmit func(ctx context.Context, userID, submissionID uuid.UUID) error
}

// SetAfterSubmit registers a step that runs after a Tier 3 submission is stored, outside its
// transaction. The demo's sandbox reviewer uses it to rule at once; a failure is logged and
// leaves the submission waiting for staff. Call it before serving requests.
func (s *Service) SetAfterSubmit(f func(ctx context.Context, userID, submissionID uuid.UUID) error) {
	s.afterSubmit = f
}

// NewService builds the service.
func NewService(cfg Config) (*Service, error) {
	if cfg.Pool == nil || cfg.Identifiers == nil || cfg.Keyring == nil || cfg.Limits == nil || cfg.Logger == nil {
		return nil, errors.New("kyc: pool, identifiers, keyring, limits and logger are required")
	}
	s := &Service{
		pool: cfg.Pool, q: kycdb.New(cfg.Pool), ids: cfg.Identifiers, keys: cfg.Keyring, provider: cfg.Provider, limits: cfg.Limits,
		blobs: cfg.Blobs, samples: map[string]bool{}, log: cfg.Logger.With("component", "kyc"), now: cfg.Now,
	}
	if s.provider == nil {
		s.provider = Sandbox{}
	}
	if s.blobs == nil {
		s.blobs = PostgresBlobs{}
	}
	if s.now == nil {
		s.now = time.Now
	}
	for _, h := range cfg.SampleHashes {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			s.samples[h] = true
		}
	}
	return s, nil
}

func principal(ctx context.Context) (identity.Principal, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return identity.Principal{}, problem.Unauthorized()
	}
	return p, nil
}

func (s *Service) inTx(ctx context.Context, fn func(tx pgx.Tx, q *kycdb.Queries) error) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error { return fn(tx, s.q.WithTx(tx)) })
}

func (s *Service) audit(ctx context.Context, tx pgx.Tx, actor audit.Actor, action, resource string, meta map[string]any) error {
	_, err := audit.Append(ctx, tx, audit.Input{Actor: actor, Action: action, ResourceType: "kyc", ResourceID: resource, Metadata: meta}, s.now())
	return err
}

// Overview is the tiers screen (KYC-1).
func (s *Service) Overview(ctx context.Context) (api.KycOverview, error) {
	p, err := principal(ctx)
	if err != nil {
		return api.KycOverview{}, err
	}
	u, err := s.q.GetUserKyc(ctx, p.UserID)
	if err != nil {
		return api.KycOverview{}, fmt.Errorf("load kyc state: %w", err)
	}
	out := api.KycOverview{Tier: api.KycTier(u.KycTier), Status: api.KycStatus(u.KycStatus), DemoLimits: true, Tiers: make([]api.TierInfo, 0, 3)}
	requirements := map[int][]string{
		1: {"Name", "Phone", "Email", "Date of birth"},
		2: {"BVN or NIN"},
		3: {"Government ID", "Selfie", "Address"},
	}
	unlocks := map[int][]api.TierInfoUnlocks{
		1: {},
		2: {"fx_wallets", "usd_cards", "higher_limits"},
		3: {"credit", "higher_limits"},
	}
	for t := 1; t <= 3; t++ {
		rule := s.limits.Rules().Tier(t)
		info := api.TierInfo{
			Tier: api.KycTier(t), DailyLimit: naira(rule.DailyMinor), Requirements: requirements[t], Current: t == int(u.KycTier),
		}
		if rule.MaxBalanceMinor > 0 {
			m := naira(rule.MaxBalanceMinor)
			info.MaxBalance = &m
		}
		un := unlocks[t]
		info.Unlocks = &un
		out.Tiers = append(out.Tiers, info)
	}
	latest, err := s.q.LatestSubmission(ctx, p.UserID)
	switch {
	case err == nil:
		sub := SubmissionJSON(latest)
		out.LatestSubmission = &sub
	case !errors.Is(err, pgx.ErrNoRows):
		return api.KycOverview{}, fmt.Errorf("load latest submission: %w", err)
	}
	return out, nil
}

func naira(minor int64) api.Money {
	return api.Money{AmountMinor: strconv.FormatInt(minor, 10), Currency: "NGN"}
}

// VerifyIdentity checks a BVN or NIN against the provider and, with a matching name (and date
// of birth when sent), upgrades the customer to Tier 2 (KYC-2). The number is encrypted at
// rest and never logged or audited.
func (s *Service) VerifyIdentity(ctx context.Context, kind Kind, number string, dob *time.Time) (api.IdentityVerification, error) {
	p, err := principal(ctx)
	if err != nil {
		return api.IdentityVerification{}, err
	}
	if kind != BVN && kind != NIN {
		return api.IdentityVerification{}, problem.Validation(problem.Field("/type", "invalid", "Choose BVN or NIN."))
	}
	number, err = normalize(kind, number)
	if err != nil {
		return api.IdentityVerification{}, err
	}
	now := s.now().UTC()
	failed, err := s.q.CountFailedChecksSince(ctx, kycdb.CountFailedChecksSinceParams{UserID: p.UserID, Since: now.Add(-time.Hour)})
	if err != nil {
		return api.IdentityVerification{}, fmt.Errorf("count failed checks: %w", err)
	}
	if failed >= identityAttemptsPerHour {
		return api.IdentityVerification{}, problem.RateLimited(now.Add(time.Hour))
	}

	var out api.IdentityVerification
	var inUse error
	err = s.inTx(ctx, func(tx pgx.Tx, q *kycdb.Queries) error {
		u, err := q.LockUserKyc(ctx, p.UserID)
		if err != nil {
			return fmt.Errorf("lock customer: %w", err)
		}
		name := u.FirstName + " " + u.LastName
		rec, found, err := s.provider.Lookup(ctx, Subject{Name: name, DateOfBirth: u.DateOfBirth}, kind, number)
		if err != nil {
			return fmt.Errorf("identity provider: %w", err)
		}
		match := api.NameMatch{Result: api.NoMatch, Confidence: 0, ExpectedName: &name}
		if found {
			o := cop.Compare(name, rec.Name)
			match.Result, match.Confidence = api.NameMatchResult(o.Result), float32(o.Confidence)
		}
		var dobMatch *bool
		if dob != nil && found {
			m := sameDay(*dob, rec.DateOfBirth)
			dobMatch = &m
		}
		verified := found && match.Result != api.NoMatch && (dobMatch == nil || *dobMatch)

		if verified {
			if err := s.ids.Save(ctx, tx, p.UserID, kind, number); err != nil {
				if errors.Is(err, ErrIdentifierInUse) {
					inUse = err
				}
				return err
			}
		}
		tier := int16(u.KycTier)
		upgraded := verified && tier < 2
		if upgraded {
			tier = 2
			if err := q.SetUserKyc(ctx, kycdb.SetUserKycParams{Tier: tier, Status: u.KycStatus, UserID: p.UserID}); err != nil {
				return fmt.Errorf("upgrade tier: %w", err)
			}
		}
		if err := s.recordCheck(ctx, q, p.UserID, kind, verified, match, dobMatch, now); err != nil {
			return err
		}
		action := "kyc.identity_failed"
		if verified {
			action = "kyc.identity_verified"
		}
		if err := s.audit(ctx, tx, audit.Customer(p.UserID), action, p.UserID.String(), map[string]any{"kind": string(kind), "provider": s.provider.Name()}); err != nil {
			return err
		}
		if upgraded {
			if err := s.emitUpdated(ctx, tx, p.UserID, int(tier), u.KycStatus, nil); err != nil {
				return err
			}
		}
		out = api.IdentityVerification{
			Type: api.IdentityVerificationType(kind), Verified: verified, NameMatch: match, Sandbox: s.provider.Sandbox(),
			DateOfBirthMatch: dobMatch, Tier: api.KycTier(tier),
		}
		return nil
	})
	if inUse != nil {
		// The attempt still counts toward the hourly cap, or guessing numbers would be free.
		_ = s.recordCheck(ctx, s.q, p.UserID, kind, false, api.NameMatch{Result: api.NoMatch}, nil, now)
		return api.IdentityVerification{}, inUse
	}
	return out, err
}

func (s *Service) recordCheck(ctx context.Context, q *kycdb.Queries, userID uuid.UUID, kind Kind, verified bool, m api.NameMatch, dob *bool, at time.Time) error {
	id, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("check id: %w", err)
	}
	var d pgtype.Bool
	if dob != nil {
		d = pgtype.Bool{Bool: *dob, Valid: true}
	}
	if err := q.InsertIdentityCheck(ctx, kycdb.InsertIdentityCheckParams{
		ID: id, UserID: userID, Kind: string(kind), Verified: verified, NameResult: string(m.Result), NameConfidence: m.Confidence,
		DobMatch: d, Provider: s.provider.Name(), CreatedAt: at,
	}); err != nil {
		return fmt.Errorf("record identity check: %w", err)
	}
	return nil
}

func sameDay(a, b time.Time) bool {
	ay, am, ad := a.UTC().Date()
	by, bm, bd := b.UTC().Date()
	return ay == by && am == bm && ad == bd
}

// SubmissionJSON is the contract's KycSubmission.
func SubmissionJSON(r kycdb.KycSubmission) api.KycSubmission {
	out := api.KycSubmission{
		Id: r.ID, TargetTier: api.KycTier(r.TargetTier), Status: api.KycSubmissionStatus(r.Status), SubmittedAt: r.SubmittedAt.UTC(),
		RejectionReason: r.RejectionReason,
	}
	if r.ReviewedAt != nil {
		t := r.ReviewedAt.UTC()
		out.ReviewedAt = &t
	}
	if len(r.ResubmitDocuments) > 0 {
		docs := make([]api.KycDocumentKind, len(r.ResubmitDocuments))
		for i, d := range r.ResubmitDocuments {
			docs[i] = api.KycDocumentKind(d)
		}
		out.ResubmitDocuments = &docs
	}
	return out
}

// TopicUpdated is the outbox event for any change to a customer's tier or KYC status. The
// realtime subscriber and the notifications subscriber both listen to it.
const TopicUpdated = "kyc.updated"

// emitUpdated writes the event in the caller's transaction. submission is nil when the change
// is not about a submission (a Tier 2 upgrade).
func (s *Service) emitUpdated(ctx context.Context, tx pgx.Tx, userID uuid.UUID, tier int, status string, submission *kycdb.KycSubmission) error {
	payload := map[string]any{"user_id": userID, "tier": tier, "status": status}
	if submission != nil {
		raw, err := json.Marshal(SubmissionJSON(*submission))
		if err != nil {
			return fmt.Errorf("kyc event: %w", err)
		}
		payload["submission"] = json.RawMessage(raw)
	}
	if _, err := jobs.Write(ctx, tx, jobs.Event{Topic: TopicUpdated, AggregateType: "user", AggregateID: userID.String(), Payload: payload}); err != nil {
		return fmt.Errorf("write %s event: %w", TopicUpdated, err)
	}
	return nil
}
