package logging

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"testing"
)

func TestLoggerWritesJSONWithServiceAndRequestID(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	log := New(&buf, slog.LevelInfo, "v1.2.3")
	log.InfoContext(WithRequestID(t.Context(), "req-1"), "hello", "user_id", "u1")

	var rec map[string]any
	if err := json.Unmarshal(buf.Bytes(), &rec); err != nil {
		t.Fatalf("not JSON: %q", buf.String())
	}
	for k, want := range map[string]string{
		"msg": "hello", "service": "nem-api", "version": "v1.2.3", "request_id": "req-1", "user_id": "u1",
	} {
		if rec[k] != want {
			t.Errorf("%s = %v, want %q", k, rec[k], want)
		}
	}
}

func TestLoggerDropsRecordsBelowLevel(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	New(&buf, slog.LevelWarn, "dev").Info("quiet")
	if buf.Len() != 0 {
		t.Fatalf("expected nothing, got %q", buf.String())
	}
}
