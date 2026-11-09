package testdb

import (
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

var fixtures = os.DirFS("testdata")

func countWidgets(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(t.Context(), "SELECT count(*) FROM widgets").Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

func TestEachTestGetsItsOwnMigratedDatabase(t *testing.T) {
	t.Parallel()

	// Both subtests create the same table at the same time; with a shared database the
	// second CREATE TABLE would fail.
	for _, name := range []string{"first", "second"} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			pool := New(t)
			Load(t, pool, fixtures, "schema.sql", "widgets.sql")

			if n := countWidgets(t, pool); n != 2 {
				t.Fatalf("widgets = %d, want 2", n)
			}
			// The template carries the migrations, so the foundation function is there.
			var hasFn bool
			if err := pool.QueryRow(t.Context(),
				"SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at')").Scan(&hasFn); err != nil || !hasFn {
				t.Fatalf("set_updated_at missing (err %v): migrations not applied", err)
			}
		})
	}
}

func TestAFailingFixtureRollsBackTheWholeLoad(t *testing.T) {
	t.Parallel()

	pool := New(t)
	Load(t, pool, fixtures, "schema.sql")

	// widgets.sql succeeds, then conflict.sql reuses id 1: neither may stick.
	if err := load(t.Context(), pool, fixtures, "widgets.sql", "conflict.sql"); err == nil {
		t.Fatal("expected the conflicting fixture to fail")
	}
	if n := countWidgets(t, pool); n != 0 {
		t.Fatalf("widgets = %d after a failed load, want 0", n)
	}
}

func TestTheTemplateNameFollowsTheMigrations(t *testing.T) {
	t.Parallel()

	a, err := migrationsHash()
	if err != nil {
		t.Fatal(err)
	}
	b, _ := migrationsHash()
	if a != b || len(a) != 16 {
		t.Fatalf("hash not stable: %q vs %q", a, b)
	}
}
