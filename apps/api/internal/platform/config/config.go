// Package config loads and validates the API's settings from environment variables.
package config

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Env is the deployment environment.
type Env string

// Supported environments.
const (
	EnvDevelopment Env = "development"
	EnvTest        Env = "test"
	EnvProduction  Env = "production"
)

// Config holds every setting the API reads at startup.
type Config struct {
	Env         Env
	Port        int
	LogLevel    slog.Level
	CORSOrigins []string
	// ClientIPHeader is the header the hosting proxy sets to the caller's address, for the
	// per-address rate limits. Empty uses the TCP peer.
	ClientIPHeader  string
	ShutdownTimeout time.Duration
	DatabaseURL     string
	DBMaxConns      int32
	MigrateOnStart  bool

	// Observability. Every exporter is optional so local runs need no accounts.
	OTLPEndpoint     string
	TraceSampleRatio float64
	SentryDSN        string
	MetricsToken     string

	// Email. Without a Brevo key, mail is logged instead of sent (refused in production).
	BrevoAPIKey   string
	MailFromEmail string
	MailFromName  string

	// OTPKey keys the HMAC one-time codes are stored under.
	OTPKey []byte
	// JWTSigningKey is the Ed25519 seed access tokens are signed with.
	JWTSigningKey []byte
}

// devOrigins are the Expo web dev server and the console's Vite dev server.
var devOrigins = []string{"http://localhost:8081", "http://localhost:5173"}

// devDatabaseURL matches docker-compose.yml.
const devDatabaseURL = "postgres://nem:nem@localhost:5433/nem?sslmode=disable" //nolint:gosec // local docker-compose credentials, not a secret

// Load reads the configuration through getenv (os.Getenv in main, a map in tests).
// Every problem is reported at once so a bad deploy shows the full list.
func Load(getenv func(string) string) (Config, error) {
	var errs []error
	get := func(key, fallback string) string {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			return v
		}
		return fallback
	}

	cfg := Config{Env: Env(get("APP_ENV", string(EnvDevelopment)))}
	switch cfg.Env {
	case EnvDevelopment, EnvTest, EnvProduction:
	default:
		errs = append(errs, fmt.Errorf("APP_ENV: %q is not development, test or production", cfg.Env))
	}

	port, err := strconv.Atoi(get("PORT", "8080"))
	if err != nil || port < 1 || port > 65535 {
		errs = append(errs, fmt.Errorf("PORT: %q is not a port number", getenv("PORT")))
	}
	cfg.Port = port

	if err := cfg.LogLevel.UnmarshalText([]byte(get("LOG_LEVEL", "info"))); err != nil {
		errs = append(errs, fmt.Errorf("LOG_LEVEL: %w", err))
	}

	timeout, err := time.ParseDuration(get("SHUTDOWN_TIMEOUT", "15s"))
	if err != nil || timeout <= 0 {
		errs = append(errs, fmt.Errorf("SHUTDOWN_TIMEOUT: %q is not a positive duration", getenv("SHUTDOWN_TIMEOUT")))
	}
	cfg.ShutdownTimeout = timeout

	cfg.CORSOrigins, err = parseOrigins(getenv("CORS_ALLOWED_ORIGINS"), cfg.Env)
	if err != nil {
		errs = append(errs, fmt.Errorf("CORS_ALLOWED_ORIGINS: %w", err))
	}

	cfg.DatabaseURL = get("DATABASE_URL", "")
	if cfg.DatabaseURL == "" {
		if cfg.Env == EnvProduction {
			errs = append(errs, errors.New("DATABASE_URL: required in production"))
		}
		cfg.DatabaseURL = devDatabaseURL
	}

	// Neon's free tier allows few connections, and Render runs one instance: keep the pool small.
	maxConns, err := strconv.ParseInt(get("DB_MAX_CONNS", "10"), 10, 32)
	if err != nil || maxConns < 1 {
		errs = append(errs, fmt.Errorf("DB_MAX_CONNS: %q is not a positive number", getenv("DB_MAX_CONNS")))
	}
	cfg.DBMaxConns = int32(maxConns)

	// On by default: Render's free tier has no pre-deploy step, so the API migrates on boot.
	cfg.MigrateOnStart, err = strconv.ParseBool(get("MIGRATE_ON_START", "true"))
	if err != nil {
		errs = append(errs, fmt.Errorf("MIGRATE_ON_START: %q is not true or false", getenv("MIGRATE_ON_START")))
	}

	// The standard OTel variable, so Grafana Cloud's copy-paste setup works unchanged.
	cfg.OTLPEndpoint = get("OTEL_EXPORTER_OTLP_ENDPOINT", "")
	if cfg.OTLPEndpoint != "" {
		if u, err := url.Parse(cfg.OTLPEndpoint); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			errs = append(errs, errors.New("OTEL_EXPORTER_OTLP_ENDPOINT: not an http(s) URL"))
		}
	}
	// Keep every trace by default: demo traffic is tiny and Grafana's free tier has room.
	cfg.TraceSampleRatio, err = strconv.ParseFloat(get("TRACE_SAMPLE_RATIO", "1"), 64)
	if err != nil || cfg.TraceSampleRatio < 0 || cfg.TraceSampleRatio > 1 {
		errs = append(errs, fmt.Errorf("TRACE_SAMPLE_RATIO: %q is not between 0 and 1", getenv("TRACE_SAMPLE_RATIO")))
	}
	cfg.ClientIPHeader = get("CLIENT_IP_HEADER", "")
	cfg.SentryDSN = get("SENTRY_DSN", "")
	// /metrics shows routes, pool sizes and runtime internals: never public in production.
	cfg.MetricsToken = get("METRICS_TOKEN", "")
	if cfg.MetricsToken == "" && cfg.Env == EnvProduction {
		errs = append(errs, errors.New("METRICS_TOKEN: required in production"))
	}

	cfg.BrevoAPIKey = get("BREVO_API_KEY", "")
	if cfg.BrevoAPIKey == "" && cfg.Env == EnvProduction {
		errs = append(errs, errors.New("BREVO_API_KEY: required in production (the log mailer would put codes in logs)"))
	}
	cfg.MailFromEmail = get("MAIL_FROM_EMAIL", "no-reply@nem.bank")
	cfg.MailFromName = get("MAIL_FROM_NAME", "Nem Bank")

	cfg.OTPKey, err = secretKey(getenv("OTP_KEY"), cfg.Env, "nem-dev-otp-key")
	if err != nil {
		errs = append(errs, fmt.Errorf("OTP_KEY: %w", err))
	}

	cfg.JWTSigningKey, err = secretKey(getenv("JWT_SIGNING_KEY"), cfg.Env, "nem-dev-jwt-key")
	if err == nil && len(cfg.JWTSigningKey) != 32 {
		err = fmt.Errorf("decodes to %d bytes, need exactly 32 (an Ed25519 seed)", len(cfg.JWTSigningKey))
	}
	if err != nil {
		errs = append(errs, fmt.Errorf("JWT_SIGNING_KEY: %w", err))
	}

	if len(errs) > 0 {
		return Config{}, fmt.Errorf("invalid config: %w", errors.Join(errs...))
	}
	return cfg, nil
}

// secretKey decodes a base64 key of 32+ bytes (`openssl rand -base64 32`). Outside
// production a missing key falls back to a fixed, publicly known development key, so
// local runs need no setup and nothing signed with it is ever trusted in production.
func secretKey(raw string, env Env, devLabel string) ([]byte, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		if env == EnvProduction {
			return nil, errors.New("required in production")
		}
		sum := sha256.Sum256([]byte(devLabel))
		return sum[:], nil
	}
	key, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil, errors.New("not valid base64")
	}
	if len(key) < 32 {
		return nil, fmt.Errorf("decodes to %d bytes, need at least 32", len(key))
	}
	return key, nil
}

// parseOrigins accepts a comma-separated list of exact origins. Wildcards are refused:
// the API takes bearer tokens, so every allowed origin should be a deliberate choice.
func parseOrigins(raw string, env Env) ([]string, error) {
	if strings.TrimSpace(raw) == "" {
		if env == EnvProduction {
			return nil, errors.New("required in production")
		}
		return devOrigins, nil
	}
	var origins []string
	for _, o := range strings.Split(raw, ",") {
		o = strings.TrimSuffix(strings.TrimSpace(o), "/")
		if o == "" {
			continue
		}
		u, err := url.Parse(o)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.Path != "" {
			return nil, fmt.Errorf("%q is not an origin like https://example.com", o)
		}
		if env == EnvProduction && u.Scheme != "https" {
			return nil, fmt.Errorf("%q must use https in production", o)
		}
		origins = append(origins, o)
	}
	return origins, nil
}

// Addr is the listen address for the HTTP server.
func (c Config) Addr() string { return ":" + strconv.Itoa(c.Port) }
