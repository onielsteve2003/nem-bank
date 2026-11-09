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
		cfg.ShutdownTimeout != 15*time.Second || !slices.Equal(cfg.CORSOrigins, devOrigins) ||
		cfg.DatabaseURL != devDatabaseURL || cfg.DBMaxConns != 10 || !cfg.MigrateOnStart ||
		cfg.OTLPEndpoint != "" || cfg.TraceSampleRatio != 1 || cfg.SentryDSN != "" || cfg.MetricsToken != "" {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
	if cfg.Addr() != ":8080" {
		t.Fatalf("Addr = %q", cfg.Addr())
	}
}

func TestLoadReadsEveryVariable(t *testing.T) {
	t.Parallel()

	cfg, err := Load(env(map[string]string{
		"APP_ENV":                     "production",
		"PORT":                        "10000",
		"LOG_LEVEL":                   "debug",
		"SHUTDOWN_TIMEOUT":            "5s",
		"CORS_ALLOWED_ORIGINS":        "https://nem-bank-fodx.vercel.app/, https://nem-console.vercel.app",
		"DATABASE_URL":                "postgres://u:p@db.example/nem?sslmode=require",
		"DB_MAX_CONNS":                "4",
		"MIGRATE_ON_START":            "false",
		"OTEL_EXPORTER_OTLP_ENDPOINT": "https://otlp-gateway.example/otlp",
		"TRACE_SAMPLE_RATIO":          "0.25",
		"SENTRY_DSN":                  "https://key@o1.ingest.sentry.io/1",
		"METRICS_TOKEN":               "scrape-secret",
		"BREVO_API_KEY":               "xkeysib-test",
		"MAIL_FROM_EMAIL":             "hello@nem.example",
		"OTP_KEY":                     "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
		"JWT_SIGNING_KEY":             "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
	}))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := []string{"https://nem-bank-fodx.vercel.app", "https://nem-console.vercel.app"}
	if cfg.Env != EnvProduction || cfg.Port != 10000 || cfg.LogLevel != slog.LevelDebug ||
		cfg.ShutdownTimeout != 5*time.Second || !slices.Equal(cfg.CORSOrigins, want) ||
		cfg.DatabaseURL != "postgres://u:p@db.example/nem?sslmode=require" || cfg.DBMaxConns != 4 || cfg.MigrateOnStart ||
		cfg.OTLPEndpoint != "https://otlp-gateway.example/otlp" || cfg.TraceSampleRatio != 0.25 ||
		cfg.SentryDSN != "https://key@o1.ingest.sentry.io/1" || cfg.MetricsToken != "scrape-secret" ||
		cfg.BrevoAPIKey != "xkeysib-test" || cfg.MailFromEmail != "hello@nem.example" ||
		string(cfg.OTPKey) != "0123456789abcdef0123456789abcdef" || len(cfg.JWTSigningKey) != 32 {
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
		{"production without a database", map[string]string{"APP_ENV": "production", "CORS_ALLOWED_ORIGINS": "https://a.com"}, "DATABASE_URL"},
		{"zero connections", map[string]string{"DB_MAX_CONNS": "0"}, "DB_MAX_CONNS"},
		{"connections past int32", map[string]string{"DB_MAX_CONNS": "9999999999"}, "DB_MAX_CONNS"},
		{"migrate flag not a bool", map[string]string{"MIGRATE_ON_START": "maybe"}, "MIGRATE_ON_START"},
		{"otlp endpoint not a url", map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": "grafana"}, "OTEL_EXPORTER_OTLP_ENDPOINT"},
		{"sample ratio above one", map[string]string{"TRACE_SAMPLE_RATIO": "1.5"}, "TRACE_SAMPLE_RATIO"},
		{"production without a metrics token", map[string]string{"APP_ENV": "production"}, "METRICS_TOKEN"},
		{"production without a brevo key", map[string]string{"APP_ENV": "production"}, "BREVO_API_KEY"},
		{"production without an otp key", map[string]string{"APP_ENV": "production"}, "OTP_KEY"},
		{"otp key not base64", map[string]string{"OTP_KEY": "not base64!"}, "OTP_KEY"},
		{"otp key too short", map[string]string{"OTP_KEY": "c2hvcnQ="}, "need at least 32"},
		{"production without a jwt key", map[string]string{"APP_ENV": "production"}, "JWT_SIGNING_KEY"},
		{"jwt key not a seed", map[string]string{"JWT_SIGNING_KEY": "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYwMTIz"}, "need exactly 32"}, // gitleaks:allow (a deliberately wrong-length test key)
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
