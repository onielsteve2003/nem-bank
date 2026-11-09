// Package testdb gives every test its own freshly migrated Postgres database.
//
//	pool := testdb.New(t)                            // empty schema at the latest migration
//	testdb.Load(t, pool, fixtures, "users.sql")      // optional SQL fixtures
//
// The server is TEST_DATABASE_URL when set (the docker compose database: fastest locally),
// otherwise one Postgres container per test binary via testcontainers-go. Migrations run
// once into a template database named after a hash of the migration files; each test then
// clones it with CREATE DATABASE ... TEMPLATE, which takes milliseconds. Tests are isolated
// and safe with t.Parallel(), and each database is dropped when its test ends.
//
// Without Docker the tests skip locally but fail in CI, so a broken runner is never green.
package testdb

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/url"
	"os"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivermigrate"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"

	"github.com/onielsteve2003/nem-bank/apps/api/db"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/database"
)

// Image matches docker-compose.yml so tests and local dev run the same Postgres.
const Image = "postgres:17-alpine"

// setupTimeout bounds container start plus template migration.
const setupTimeout = 2 * time.Minute

// Process-wide on purpose: one server and one template per test binary, shared by every
// test in it. This is test-only state; production code takes its dependencies explicitly.
var (
	server   = sync.OnceValues(startServer)
	template = sync.OnceValues(func() (string, error) {
		admin, err := server()
		if err != nil {
			return "", err
		}
		return ensureTemplate(admin)
	})
)

// New returns a pool on a new database at the latest migration, dropped after the test.
func New(t *testing.T) *pgxpool.Pool {
	t.Helper()
	if os.Getenv("TEST_DATABASE_URL") == "" && os.Getenv("CI") == "" {
		testcontainers.SkipIfProviderIsNotHealthy(t)
	}
	admin, err := server()
	if err != nil {
		t.Fatalf("testdb: start postgres: %v", err)
	}
	tpl, err := template()
	if err != nil {
		t.Fatalf("testdb: prepare template: %v", err)
	}

	ctx := t.Context()
	name := "t_" + randomHex(8)
	if err := adminExec(ctx, admin, "CREATE DATABASE "+ident(name)+" TEMPLATE "+ident(tpl)); err != nil {
		t.Fatalf("testdb: create database: %v", err)
	}
	pool, err := database.Open(ctx, withDatabase(admin, name), 4)
	if err != nil {
		t.Fatalf("testdb: open: %v", err)
	}
	t.Cleanup(func() {
		pool.Close()
		// t.Context() is already canceled when cleanups run.
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := adminExec(ctx, admin, "DROP DATABASE IF EXISTS "+ident(name)+" WITH (FORCE)"); err != nil {
			t.Logf("testdb: drop %s: %v", name, err)
		}
	})
	return pool
}

// Load runs SQL fixture files from fsys, in the order given, in one transaction.
func Load(t *testing.T, pool *pgxpool.Pool, fsys fs.FS, names ...string) {
	t.Helper()
	if err := load(t.Context(), pool, fsys, names...); err != nil {
		t.Fatalf("testdb: %v", err)
	}
}

func load(ctx context.Context, pool *pgxpool.Pool, fsys fs.FS, names ...string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin fixtures: %w", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	for _, name := range names {
		sql, err := fs.ReadFile(fsys, name)
		if err != nil {
			return fmt.Errorf("read fixture %s: %w", name, err)
		}
		if _, err := tx.Exec(ctx, string(sql)); err != nil {
			return fmt.Errorf("load fixture %s: %w", name, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit fixtures: %w", err)
	}
	return nil
}

// startServer returns an admin connection URL for a server tests may create databases on.
func startServer() (string, error) {
	if u := os.Getenv("TEST_DATABASE_URL"); u != "" {
		return u, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), setupTimeout)
	defer cancel()
	// The container outlives this function and is removed by the testcontainers reaper
	// when the test binary exits.
	c, err := tcpostgres.Run(ctx, Image,
		tcpostgres.WithDatabase("nem"),
		tcpostgres.WithUsername("nem"),
		tcpostgres.WithPassword("nem"),
		tcpostgres.BasicWaitStrategies(),
		// Durability is pointless for throwaway data; these make migrations and clones faster.
		testcontainers.WithCmdArgs("-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off"),
	)
	if err != nil {
		return "", err
	}
	return c.ConnectionString(ctx, "sslmode=disable")
}

// ensureTemplate creates the migrated template database once per migration set. An
// advisory lock serializes test binaries that start together; building under a temporary
// name and renaming means a crash mid-migration never leaves a half-built template.
func ensureTemplate(admin string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), setupTimeout)
	defer cancel()

	hash, err := migrationsHash()
	if err != nil {
		return "", err
	}
	name := "nem_tpl_" + hash

	conn, err := pgx.Connect(ctx, admin)
	if err != nil {
		return "", fmt.Errorf("connect: %w", err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock(hashtext('nem_testdb_template'))"); err != nil {
		return "", fmt.Errorf("lock: %w", err)
	}
	// Closing the connection also releases the lock if anything below fails.
	defer func() {
		_, _ = conn.Exec(context.Background(), "SELECT pg_advisory_unlock(hashtext('nem_testdb_template'))")
	}()

	var exists bool
	if err := conn.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)", name).Scan(&exists); err != nil {
		return "", fmt.Errorf("look up template: %w", err)
	}
	if exists {
		return name, nil
	}

	// Templates for older migration sets are dead weight on a long-lived local database.
	rows, err := conn.Query(ctx, "SELECT datname FROM pg_database WHERE datname LIKE 'nem\\_tpl\\_%'")
	if err != nil {
		return "", fmt.Errorf("list old templates: %w", err)
	}
	stale, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return "", fmt.Errorf("list old templates: %w", err)
	}
	for _, old := range stale {
		if _, err := conn.Exec(ctx, "DROP DATABASE IF EXISTS "+ident(old)+" WITH (FORCE)"); err != nil {
			return "", fmt.Errorf("drop old template %s: %w", old, err)
		}
	}

	build := name + "_build"
	if _, err := conn.Exec(ctx, "CREATE DATABASE "+ident(build)); err != nil {
		return "", fmt.Errorf("create template: %w", err)
	}
	pool, err := database.Open(ctx, withDatabase(admin, build), 2)
	if err != nil {
		return "", err
	}
	err = database.Migrate(ctx, pool, slog.New(slog.NewTextHandler(io.Discard, nil)))
	// A template cannot be cloned or renamed while anything is connected to it.
	pool.Close()
	if err != nil {
		return "", err
	}
	if _, err := conn.Exec(ctx, "ALTER DATABASE "+ident(build)+" RENAME TO "+ident(name)); err != nil {
		return "", fmt.Errorf("publish template: %w", err)
	}
	return name, nil
}

// migrationsHash names the template after the exact migration files, ours and River's (which
// change with the River version), so any schema change builds a new template instead of
// reusing a stale one.
func migrationsHash() (string, error) {
	files, err := fs.Glob(db.Migrations, "migrations/*.sql")
	if err != nil {
		return "", fmt.Errorf("list migrations: %w", err)
	}
	sort.Strings(files)
	h := sha256.New()
	for _, f := range files {
		b, err := fs.ReadFile(db.Migrations, f)
		if err != nil {
			return "", fmt.Errorf("read %s: %w", f, err)
		}
		_, _ = fmt.Fprintf(h, "%s\x00%d\x00", f, len(b)) // hash.Hash writes never fail
		h.Write(b)
	}
	// A driver without a pool is enough to list River's embedded migrations.
	river, err := rivermigrate.New(riverpgxv5.New(nil), nil)
	if err != nil {
		return "", fmt.Errorf("list river migrations: %w", err)
	}
	for _, m := range river.AllVersions() {
		_, _ = fmt.Fprintf(h, "river/%d\x00%s", m.Version, m.SQLUp)
	}
	return hex.EncodeToString(h.Sum(nil))[:16], nil
}

func adminExec(ctx context.Context, admin, sql string) error {
	conn, err := pgx.Connect(ctx, admin)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close(context.Background()) }()
	_, err = conn.Exec(ctx, sql)
	return err
}

// withDatabase swaps the database name in a postgres:// URL.
func withDatabase(admin, name string) string {
	u, err := url.Parse(admin)
	if err != nil {
		// startServer only hands out URLs that parsed; keep the password out of any message.
		panic("testdb: admin URL does not parse")
	}
	u.Path = "/" + name
	return u.String()
}

func ident(name string) string { return pgx.Identifier{name}.Sanitize() }

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b) // crypto/rand.Read never returns an error
	return hex.EncodeToString(b)
}
