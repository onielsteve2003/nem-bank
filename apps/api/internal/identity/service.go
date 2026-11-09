// Package identity owns customers and how they prove who they are: sign-up, passwords,
// email one-time codes, sessions, devices and the transaction PIN (PRD FR-AUTH).
package identity

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity/identitydb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/mailer"
)

// Config holds the service's secrets and dependencies.
type Config struct {
	Pool   *pgxpool.Pool
	Mailer mailer.Mailer
	Logger *slog.Logger
	// OTPKey keys the HMAC that one-time codes are stored under (32+ random bytes).
	OTPKey []byte
	// Hasher defaults to argon2id with DefaultArgon2 and 4 concurrent hashes.
	Hasher *Hasher
	// Now defaults to time.Now.
	Now func() time.Time
}

// Service implements the identity use cases.
type Service struct {
	pool   *pgxpool.Pool
	q      *identitydb.Queries
	mail   mailer.Mailer
	log    *slog.Logger
	otpKey []byte
	hasher *Hasher
	now    func() time.Time
}

// NewService checks the configuration and returns the service.
func NewService(cfg Config) (*Service, error) {
	if cfg.Pool == nil || cfg.Mailer == nil || cfg.Logger == nil {
		return nil, errors.New("identity: pool, mailer and logger are required")
	}
	if len(cfg.OTPKey) < 32 {
		return nil, errors.New("identity: OTP key must be at least 32 bytes")
	}
	if cfg.Hasher == nil {
		cfg.Hasher = NewHasher(DefaultArgon2, 4)
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Service{
		pool: cfg.Pool, q: identitydb.New(cfg.Pool), mail: cfg.Mailer, log: cfg.Logger,
		otpKey: cfg.OTPKey, hasher: cfg.Hasher, now: cfg.Now,
	}, nil
}

// inTx runs fn in a transaction, committing only if it returns nil.
func (s *Service) inTx(ctx context.Context, fn func(q *identitydb.Queries) error) error {
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error { return fn(s.q.WithTx(tx)) })
	if err != nil {
		return fmt.Errorf("identity tx: %w", err)
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

// uniqueViolation returns the constraint name of a unique violation, or "".
func uniqueViolation(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return pgErr.ConstraintName
	}
	return ""
}
