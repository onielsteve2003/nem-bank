package database

import "testing"

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
