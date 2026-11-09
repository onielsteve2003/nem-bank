// Package database owns the Postgres connection pool and schema migrations.
package database

import (
	"context"
	"fmt"
	"io/fs"
	"log/slog"
	"time"

	"github.com/exaring/otelpgx"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivermigrate"

	"github.com/onielsteve2003/nem-bank/apps/api/db"
)

// Open connects a pgx pool and checks it with a ping, so a bad DATABASE_URL fails at startup
// instead of on the first request.
func Open(ctx context.Context, url string, maxConns int32) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		// The parse error can echo the URL, password included, so keep it out of the message.
		return nil, fmt.Errorf("parse DATABASE_URL: invalid connection string")
	}
	cfg.MaxConns = maxConns
	// Neon suspends an idle database; close idle connections well before that rather than
	// handing a dead one to a request.
	cfg.MinConns = 0
	cfg.MaxConnIdleTime = 4 * time.Minute
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.HealthCheckPeriod = time.Minute
	// One span per query under the request's trace. The SQL text is recorded, never the
	// arguments (otelpgx's default), so no customer data reaches the trace backend.
	cfg.ConnConfig.Tracer = otelpgx.NewTracer()

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}
	// A cold Neon database takes a few seconds to wake.
	pingCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return pool, nil
}

// Migrate applies every pending migration embedded in the binary. A Postgres advisory lock
// makes it safe when two instances start at once: the second waits, then finds nothing to do.
func Migrate(ctx context.Context, pool *pgxpool.Pool, log *slog.Logger) error {
	migrations, err := fs.Sub(db.Migrations, "migrations")
	if err != nil {
		return fmt.Errorf("open embedded migrations: %w", err)
	}
	locker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		return fmt.Errorf("create migration lock: %w", err)
	}

	sqlDB := stdlib.OpenDBFromPool(pool)
	defer func() { _ = sqlDB.Close() }()

	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, migrations, goose.WithSessionLocker(locker))
	if err != nil {
		return fmt.Errorf("create migration provider: %w", err)
	}
	results, err := provider.Up(ctx)
	if err != nil {
		return fmt.Errorf("apply migrations: %w", err)
	}
	for _, r := range results {
		log.InfoContext(ctx, "migration applied", "schema_version", r.Source.Version, "file", r.Source.Path, "duration_ms", r.Duration.Milliseconds())
	}
	version, err := provider.GetDBVersion(ctx)
	if err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}
	log.InfoContext(ctx, "schema up to date", "schema_version", version, "applied_now", len(results))
	return migrateRiver(ctx, pool, log)
}

// migrateRiver applies River's own job-queue schema. River ships its migrations as a
// library, so they track the River version in go.mod rather than living in db/migrations.
// A session advisory lock, held on its own connection, makes concurrent boots wait their
// turn like goose's lock does.
func migrateRiver(ctx context.Context, pool *pgxpool.Pool, log *slog.Logger) error {
	migrator, err := rivermigrate.New(riverpgxv5.New(pool), &rivermigrate.Config{Logger: log})
	if err != nil {
		return fmt.Errorf("create river migrator: %w", err)
	}
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire river migration lock connection: %w", err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock(hashtext('nem_river_migrate'))"); err != nil {
		return fmt.Errorf("lock river migration: %w", err)
	}
	defer func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), "SELECT pg_advisory_unlock(hashtext('nem_river_migrate'))")
	}()
	res, err := migrator.Migrate(ctx, rivermigrate.DirectionUp, nil)
	if err != nil {
		return fmt.Errorf("apply river migrations: %w", err)
	}
	log.InfoContext(ctx, "river schema up to date", "applied_now", len(res.Versions))
	return nil
}
