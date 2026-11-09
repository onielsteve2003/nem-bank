package database_test

import (
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/database"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/database/platformdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

func TestMigrateIsANoOpOnAnUpToDateSchemaAndSqlcQueriesWork(t *testing.T) {
	t.Parallel()

	pool := testdb.New(t) // already migrated from the template
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	for range 2 {
		if err := database.Migrate(t.Context(), pool, log); err != nil {
			t.Fatalf("Migrate: %v", err)
		}
	}

	now, err := platformdb.New(pool).ServerTime(t.Context())
	if err != nil {
		t.Fatalf("ServerTime: %v", err)
	}
	if d := time.Since(now); d < -time.Minute || d > time.Minute {
		t.Fatalf("database clock is %v away from ours", d)
	}
}
