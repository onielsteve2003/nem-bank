// Package demo is the demo path of the real bank: a tap on "Try the demo" creates a fresh
// customer with a persona's six months of history, and Demo Controls (DEMO-1) act on that
// customer only. Demo customers are ordinary customers flagged is_demo, so every rule of
// the bank still applies to them.
package demo

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// Pin is every demo customer's transaction PIN, shown in the app's demo disclaimer.
const Pin = "2580"

// Config holds the service's dependencies.
type Config struct {
	Pool     *pgxpool.Pool
	Identity *identity.Service
	// Now defaults to time.Now.
	Now func() time.Time
}

// Service implements the demo operations.
type Service struct {
	pool *pgxpool.Pool
	id   *identity.Service
	now  func() time.Time
}

// NewService checks the configuration and returns the service.
func NewService(cfg Config) (*Service, error) {
	if cfg.Pool == nil || cfg.Identity == nil {
		return nil, errors.New("demo: pool and identity are required")
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Service{pool: cfg.Pool, id: cfg.Identity, now: cfg.Now}, nil
}

// ErrUnknownPersona is a persona the demo does not have.
var ErrUnknownPersona = problem.Validation(problem.Field("/persona", "unknown", "Pick one of the demo personas."))

// Start creates a demo customer as the persona and opens a session on the caller's device.
func (s *Service) Start(ctx context.Context, persona string, device identity.DeviceRegistration) (identity.AuthResult, error) {
	p, ok := personas[persona]
	if !ok {
		return identity.AuthResult{}, ErrUnknownPersona
	}
	now := s.now()
	return s.id.StartDemo(ctx, identity.DemoUser{
		FirstName: p.first, LastName: p.last, NemtagBase: p.tagBase, DateOfBirth: p.born,
		KycTier: p.tier, KycStatus: p.kycStatus, Pin: Pin,
	}, device, func(ctx context.Context, tx pgx.Tx, userID uuid.UUID) error {
		return p.seed(ctx, tx, userID, now)
	})
}
