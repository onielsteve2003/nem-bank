// Package family is the family domain (FR-FAM): a parent adds a dependant who has their own
// account and @nemtag (FAM-1), sets what the dependant may spend, pays them an allowance and
// approves the transfers that go above a threshold (FAM-2), and can read their activity (FAM-3).
//
// Controls bite where money leaves the dependant's account. transfers calls Screen for every send
// a dependant makes (a scheduled one included): a paused account or a transfer to another bank
// the parent switched off is refused, a day's spending over the limit is refused, and a transfer
// above the approval threshold is set aside (a ledger hold) and waits here for the parent.
// Approving sends it as the dependant (transfers.SendAs); declining or letting it expire gives
// the money back.
//
// Not covered by the controls yet: bill payments, card spending and currency conversion by a
// dependant. Their limits come from the KYC tier alone until those domains call Screen too.
package family

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/family/familydb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/limits"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers"
)

// Policy. Each number has a reason.
const (
	// MaxDependants is the contract's cap on one parent's dependants.
	MaxDependants = 5
	// MinAge is the youngest a dependant can be: younger children do not transact.
	MinAge = 6
	// MaxAge is the oldest: an 18-year-old signs up as an adult.
	MaxAge = 17
	// ApprovalTTL is how long a parent has to answer before the request lapses and the money is
	// given back.
	ApprovalTTL = 24 * time.Hour
	// SetupCodeTTL is how long the child's setup code works.
	SetupCodeTTL = 24 * time.Hour
	// StepUpPurpose is the step-up that adding a dependant needs (the same one as adding a
	// beneficiary: a new person who can be paid and who pays).
	StepUpPurpose = "new_beneficiary"
	// runBatch is how many due allowances or lapsed approvals one clock pass takes.
	runBatch = 50
)

// Events, for notifications to word.
const (
	TopicApprovalRequested = "family.approval_requested"
	TopicApprovalDecided   = "family.approval_decided"
	TopicAllowanceSent     = "family.allowance_sent"
	TopicAllowanceFailed   = "family.allowance_failed"
)

// Problems.
var (
	errDependantNotFound = problem.NotFound("Dependant")
	errApprovalNotFound  = problem.NotFound("Approval")
	errNotOpen           = problem.New(http.StatusConflict, "invalid_state", "This request is no longer open")
	errTooMany           = problem.New(http.StatusConflict, problem.CodeConflict, "You have reached the limit of dependants").
				WithDetailf("You can add up to %d dependants.", MaxDependants)
	errPaused = problem.New(http.StatusForbidden, "family_paused", "This account is paused").
			WithDetail("Ask your parent to turn it back on.")
	errBankTransfers = problem.New(http.StatusForbidden, "family_bank_transfers_off", "Sending to other banks is off").
				WithDetail("Your parent has turned off transfers to other banks. You can still pay Nem users.")
	errAge = problem.Validation(problem.Field("/date_of_birth", "age", fmt.Sprintf("Dependants are %d to %d years old.", MinAge, MaxAge)))
)

// Customers is what family needs from identity.
type Customers interface {
	CustomerProfile(ctx context.Context, userID uuid.UUID) (identity.CustomerProfile, error)
}

// StepUps spends the step-up token that adding a dependant needs.
type StepUps interface {
	ConsumeStepUp(ctx context.Context, tx pgx.Tx, userID uuid.UUID, purpose, token string) error
}

// Sender sends money for a customer when none of their devices is calling.
type Sender interface {
	SendAs(ctx context.Context, userID uuid.UUID, r transfers.Request, h transfers.Hooks) (uuid.UUID, error)
}

// Config holds the service's dependencies.
type Config struct {
	Pool      *pgxpool.Pool
	Accounts  *accounts.Service
	Customers Customers
	StepUps   StepUps
	Sender    Sender
	// Limits reports what a dependant has already sent today.
	Limits *limits.Service
	// CodeKey keys the HMAC that setup codes are kept under; at least 32 bytes.
	CodeKey []byte
	Logger  *slog.Logger
	// Now defaults to time.Now.
	Now func() time.Time
}

// Service is the family domain.
type Service struct {
	pool      *pgxpool.Pool
	q         *familydb.Queries
	accounts  *accounts.Service
	customers Customers
	stepUps   StepUps
	sender    Sender
	limits    *limits.Service
	key       []byte
	log       *slog.Logger
	now       func() time.Time
}

// NewService checks the configuration and returns the service.
func NewService(cfg Config) (*Service, error) {
	if cfg.Pool == nil || cfg.Accounts == nil || cfg.Customers == nil || cfg.Sender == nil || cfg.Limits == nil || cfg.Logger == nil {
		return nil, errors.New("family: pool, accounts, customers, sender, limits and logger are required")
	}
	if len(cfg.CodeKey) < 32 {
		return nil, errors.New("family: the code key must be at least 32 bytes")
	}
	s := &Service{
		pool: cfg.Pool, q: familydb.New(cfg.Pool), accounts: cfg.Accounts, customers: cfg.Customers, stepUps: cfg.StepUps,
		sender: cfg.Sender, limits: cfg.Limits, key: cfg.CodeKey, log: cfg.Logger.With("component", "family"), now: cfg.Now,
	}
	if s.now == nil {
		s.now = time.Now
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

// emit writes an outbox event in the caller's transaction.
func emit(ctx context.Context, tx pgx.Tx, topic, aggregateType string, id uuid.UUID, payload map[string]any) error {
	if _, err := jobs.Write(ctx, tx, jobs.Event{Topic: topic, AggregateType: aggregateType, AggregateID: id.String(), Payload: payload}); err != nil {
		return fmt.Errorf("write %s event: %w", topic, err)
	}
	return nil
}

// newSetupCode is eight random digits, drawn without modulo bias.
func newSetupCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(100_000_000))
	if err != nil {
		return "", fmt.Errorf("setup code: %w", err)
	}
	return fmt.Sprintf("%08d", n.Int64()), nil
}

// codeHash is the setup code as it is stored: bound to the dependant, so one code cannot be
// matched against another's.
func (s *Service) codeHash(dependant uuid.UUID, code string) []byte {
	m := hmac.New(sha256.New, s.key)
	m.Write([]byte("nem dependant setup code v1"))
	m.Write(dependant[:])
	m.Write([]byte(code))
	return m.Sum(nil)
}

// CheckSetupCode reports whether code is the dependant's live setup code. The child's device
// binding (a contract operation that does not exist yet) will call it.
func (s *Service) CheckSetupCode(ctx context.Context, dependant uuid.UUID, code string) (bool, error) {
	d, err := s.q.GetDependantByID(ctx, dependant)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("load dependant: %w", err)
	}
	if d.SetupCodeHash == nil || d.SetupCodeExpiresAt == nil || !s.now().Before(*d.SetupCodeExpiresAt) {
		return false, nil
	}
	return hmac.Equal(d.SetupCodeHash, s.codeHash(dependant, code)), nil
}
