// Package admin is the staff realm (FR-ADM): staff accounts, password + TOTP login,
// console sessions, role checks and the maker-checker framework that sensitive staff
// actions go through (ADM-1, ADM-10).
//
// Staff are a separate realm from customers: their own table, sessions, signing key and
// token audience, so a customer token can never open the console, and the reverse.
package admin

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/admin/admindb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/audit"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/fieldcrypt"
)

// Config holds the service's secrets and dependencies.
type Config struct {
	Pool   *pgxpool.Pool
	Logger *slog.Logger
	// SigningKey is the 32-byte Ed25519 seed console tokens are signed with. It must not be
	// the customer key: a leak of one realm's key must not open the other.
	SigningKey []byte
	// Keyring encrypts TOTP secrets at rest.
	Keyring *fieldcrypt.Keyring
	// Hasher defaults to argon2id with identity.DefaultArgon2 and 2 concurrent hashes.
	Hasher *identity.Hasher
	// Now defaults to time.Now.
	Now func() time.Time
}

// Service implements staff login, sessions and maker-checker.
type Service struct {
	pool    *pgxpool.Pool
	q       *admindb.Queries
	log     *slog.Logger
	tokens  *tokenSigner
	keyring *fieldcrypt.Keyring
	hasher  *identity.Hasher
	now     func() time.Time

	// dummyHash is verified against when a login names no staff member, so an unknown
	// email costs the same time as a wrong password.
	dummyHash func() (string, error)

	mu      sync.RWMutex
	actions map[Action]ActionHandler
}

// NewService checks the configuration and returns the service.
func NewService(cfg Config) (*Service, error) {
	if cfg.Pool == nil || cfg.Logger == nil || cfg.Keyring == nil {
		return nil, errors.New("admin: pool, logger and keyring are required")
	}
	if cfg.Hasher == nil {
		cfg.Hasher = identity.NewHasher(identity.DefaultArgon2, 2)
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	tokens, err := newTokenSigner(cfg.SigningKey)
	if err != nil {
		return nil, err
	}
	hasher := cfg.Hasher
	return &Service{
		pool: cfg.Pool, q: admindb.New(cfg.Pool), log: cfg.Logger, tokens: tokens,
		keyring: cfg.Keyring, hasher: hasher, now: cfg.Now,
		dummyHash: sync.OnceValues(func() (string, error) {
			return hasher.Hash(context.Background(), "not-a-real-password")
		}),
		actions: map[Action]ActionHandler{},
	}, nil
}

func (s *Service) inTx(ctx context.Context, fn func(tx pgx.Tx, q *admindb.Queries) error) error {
	if err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error { return fn(tx, s.q.WithTx(tx)) }); err != nil {
		return fmt.Errorf("admin tx: %w", err)
	}
	return nil
}

func newID() (uuid.UUID, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return uuid.Nil, fmt.Errorf("new id: %w", err)
	}
	return id, nil
}

// staffActor is a staff member in the audit log. Staff are named there (customers are not):
// the log exists to show which employee did what.
func staffActor(id uuid.UUID, name string) audit.Actor {
	sid := id.String()
	return audit.Actor{Type: audit.ActorStaff, ID: &sid, Name: &name}
}

func (s *Service) audit(ctx context.Context, tx pgx.Tx, actor audit.Actor, action, resourceType, resourceID string, meta map[string]any) error {
	_, err := audit.Append(ctx, tx, audit.Input{
		Actor: actor, Action: action, ResourceType: resourceType, ResourceID: resourceID, Metadata: meta,
	}, s.now())
	if err != nil {
		return fmt.Errorf("audit %s: %w", action, err)
	}
	return nil
}
