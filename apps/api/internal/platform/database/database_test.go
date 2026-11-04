package database

import (
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/database/platformdb"
)

// Runs against a real Postgres when TEST_DATABASE_URL is set (for example the
// docker-compose database). T22.6 replaces this with a testcontainers harness.
func TestOpenMigrateAndQuery(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := t.Context()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	pool, err := Open(ctx, url, 2)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)

	// Twice: the second run must find nothing to do.
	for range 2 {
		if err := Migrate(ctx, pool, log); err != nil {
			t.Fatalf("Migrate: %v", err)
		}
	}

	now, err := platformdb.New(pool).ServerTime(ctx)
	if err != nil {
		t.Fatalf("ServerTime: %v", err)
	}
	if d := time.Since(now); d < -time.Minute || d > time.Minute {
		t.Fatalf("database clock is %v away from ours", d)
	}
}

func TestOpenKeepsThePasswordOutOfParseErrors(t *testing.T) {
	t.Parallel()

	_, err := Open(t.Context(), "postgres://u:s3cret@host:notaport/db", 1)
	if err == nil {
		t.Fatal("expected an error")
	}
	if got := err.Error(); got != "parse DATABASE_URL: invalid connection string" {
		t.Fatalf("err = %q", got)
	}
}
