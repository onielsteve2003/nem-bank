package config

import (
	"log/slog"
	"slices"
	"strings"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLoadUsesDevelopmentDefaults(t *testing.T) {
	t.Parallel()

	cfg, err := Load(env(nil))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Env != EnvDevelopment || cfg.Port != 8080 || cfg.LogLevel != slog.LevelInfo ||
		cfg.ShutdownTimeout != 15*time.Second || !slices.Equal(cfg.CORSOrigins, devOrigins) {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
	if cfg.Addr() != ":8080" {
		t.Fatalf("Addr = %q", cfg.Addr())
	}
}

func TestLoadReadsEveryVariable(t *testing.T) {
	t.Parallel()

	cfg, err := Load(env(map[string]string{
		"APP_ENV":              "production",
		"PORT":                 "10000",
		"LOG_LEVEL":            "debug",
		"SHUTDOWN_TIMEOUT":     "5s",
		"CORS_ALLOWED_ORIGINS": "https://nem-bank-fodx.vercel.app/, https://nem-console.vercel.app",
	}))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := []string{"https://nem-bank-fodx.vercel.app", "https://nem-console.vercel.app"}
	if cfg.Env != EnvProduction || cfg.Port != 10000 || cfg.LogLevel != slog.LevelDebug ||
		cfg.ShutdownTimeout != 5*time.Second || !slices.Equal(cfg.CORSOrigins, want) {
		t.Fatalf("unexpected config: %+v", cfg)
	}
}

func TestLoadRejectsBadValues(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"unknown env", map[string]string{"APP_ENV": "staging"}, "APP_ENV"},
		{"port not a number", map[string]string{"PORT": "eighty"}, "PORT"},
		{"port out of range", map[string]string{"PORT": "70000"}, "PORT"},
		{"unknown log level", map[string]string{"LOG_LEVEL": "loud"}, "LOG_LEVEL"},
		{"negative timeout", map[string]string{"SHUTDOWN_TIMEOUT": "-1s"}, "SHUTDOWN_TIMEOUT"},
		{"wildcard origin", map[string]string{"CORS_ALLOWED_ORIGINS": "*"}, "CORS_ALLOWED_ORIGINS"},
		{"origin with a path", map[string]string{"CORS_ALLOWED_ORIGINS": "https://a.com/app"}, "CORS_ALLOWED_ORIGINS"},
		{"production without origins", map[string]string{"APP_ENV": "production"}, "required in production"},
		{"production over http", map[string]string{"APP_ENV": "production", "CORS_ALLOWED_ORIGINS": "http://a.com"}, "https"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := Load(env(tt.env))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("err = %v, want it to mention %q", err, tt.want)
			}
		})
	}
}

func TestLoadReportsEveryProblemAtOnce(t *testing.T) {
	t.Parallel()

	_, err := Load(env(map[string]string{"PORT": "x", "LOG_LEVEL": "loud"}))
	if err == nil || !strings.Contains(err.Error(), "PORT") || !strings.Contains(err.Error(), "LOG_LEVEL") {
		t.Fatalf("err = %v, want both PORT and LOG_LEVEL", err)
	}
}
