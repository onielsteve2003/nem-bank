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

	// Language models for Nem Assistant (AI-6) and the optional ID prefill. Both optional: with
	// neither key the assistant answers 503 and the app shows its shortcuts. Gemini is tried
	// first, Groq when Gemini is out of quota or down.
	GeminiAPIKey, GeminiModel string
	GroqAPIKey, GroqModel     string

	// KYCSampleIDHashes are SHA-256 digests (hex) of the demo's sample ID images. Only an upload
	// matching one can be read by the optional AI ID prefill; empty means prefill never runs.
	KYCSampleIDHashes []string

	// OTPKey keys the HMAC one-time codes are stored under.
	OTPKey []byte
	// JWTSigningKey is the Ed25519 seed access tokens are signed with.
	JWTSigningKey []byte
	// StaffJWTSigningKey signs console (staff) tokens. A separate key keeps the realms
	// apart: a leaked customer key cannot mint a staff token.
	StaffJWTSigningKey []byte
	// FieldKeys are the AES-256 keys for field encryption, by version; the highest
	// encrypts. FieldIndexKey keys the blind indexes. See internal/platform/fieldcrypt.
	FieldKeys     map[uint16][]byte
	FieldIndexKey []byte

	// BankPartner carries interbank transfers: "sandbox_nip" (default) or "paystack_test".
	BankPartner string
	// RiskMode is what the fraud risk engine does (AI-1): "enforce" (default) stops transfers
	// it flags, "shadow" scores and records them without stopping any, "off" skips scoring.
	RiskMode string
	// PaystackSecretKey is a Paystack test key, required for paystack_test.
	PaystackSecretKey string
	// SandboxNIPSecret signs the sandbox rail's callbacks and verifies them on the way in.
	SandboxNIPSecret []byte
	// SandboxNIPCallbackURL is where the sandbox calls back; default this process over
	// loopback, so callbacks never leave the container.
	SandboxNIPCallbackURL string

	// PublicURL is where this API is reachable from outside ("https://api.example.com"). Emails
	// use it to build links, such as the data export download.
	PublicURL string
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

	cfg.GeminiAPIKey, cfg.GeminiModel = get("GEMINI_API_KEY", ""), get("GEMINI_MODEL", "")
	cfg.GroqAPIKey, cfg.GroqModel = get("GROQ_API_KEY", ""), get("GROQ_MODEL", "")
	for _, h := range strings.Split(get("KYC_SAMPLE_ID_SHA256", ""), ",") {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			cfg.KYCSampleIDHashes = append(cfg.KYCSampleIDHashes, h)
		}
	}

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

	cfg.StaffJWTSigningKey, err = secretKey(getenv("STAFF_JWT_SIGNING_KEY"), cfg.Env, "nem-dev-staff-jwt-key")
	if err == nil && len(cfg.StaffJWTSigningKey) != 32 {
		err = fmt.Errorf("decodes to %d bytes, need exactly 32 (an Ed25519 seed)", len(cfg.StaffJWTSigningKey))
	}
	if err == nil && string(cfg.StaffJWTSigningKey) == string(cfg.JWTSigningKey) {
		err = errors.New("must differ from JWT_SIGNING_KEY")
	}
	if err != nil {
		errs = append(errs, fmt.Errorf("STAFF_JWT_SIGNING_KEY: %w", err))
	}

	cfg.FieldKeys, err = fieldKeys(getenv("FIELD_ENCRYPTION_KEYS"), cfg.Env)
	if err != nil {
		errs = append(errs, fmt.Errorf("FIELD_ENCRYPTION_KEYS: %w", err))
	}
	cfg.FieldIndexKey, err = secretKey(getenv("FIELD_INDEX_KEY"), cfg.Env, "nem-dev-field-index-key")
	if err != nil {
		errs = append(errs, fmt.Errorf("FIELD_INDEX_KEY: %w", err))
	}

	cfg.BankPartner = get("BANK_PARTNER", "sandbox_nip")
	cfg.PaystackSecretKey = get("PAYSTACK_SECRET_KEY", "")
	switch cfg.BankPartner {
	case "sandbox_nip":
	case "paystack_test":
		// The demo runs on simulated money: a live key is refused, not just discouraged.
		if !strings.HasPrefix(cfg.PaystackSecretKey, "sk_test_") {
			errs = append(errs, errors.New("PAYSTACK_SECRET_KEY: a Paystack test key (sk_test_...) is required for paystack_test"))
		}
	default:
		errs = append(errs, fmt.Errorf("BANK_PARTNER: %q is not sandbox_nip or paystack_test", cfg.BankPartner))
	}
	cfg.RiskMode = get("RISK_MODE", "enforce")
	switch cfg.RiskMode {
	case "enforce", "shadow", "off":
	default:
		errs = append(errs, fmt.Errorf("RISK_MODE: %q is not enforce, shadow or off", cfg.RiskMode))
	}
	cfg.SandboxNIPSecret, err = secretKey(getenv("SANDBOX_NIP_WEBHOOK_SECRET"), cfg.Env, "nem-dev-sandbox-nip-webhook")
	if err != nil {
		errs = append(errs, fmt.Errorf("SANDBOX_NIP_WEBHOOK_SECRET: %w", err))
	}
	cfg.PublicURL = strings.TrimRight(get("PUBLIC_URL", "http://127.0.0.1:"+strconv.Itoa(cfg.Port)), "/")
	cfg.SandboxNIPCallbackURL = get("SANDBOX_NIP_CALLBACK_URL", "http://127.0.0.1:"+strconv.Itoa(cfg.Port)+"/v1/partner-webhooks/sandbox_nip")

	if len(errs) > 0 {
		return Config{}, fmt.Errorf("invalid config: %w", errors.Join(errs...))
	}
	return cfg, nil
}

// fieldKeys parses "1:<base64>,2:<base64>": each version with an exact 32-byte key.
// Rotation adds a version; the old one stays listed until every row is rewrapped.
func fieldKeys(raw string, env Env) (map[uint16][]byte, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		if env == EnvProduction {
			return nil, errors.New("required in production")
		}
		sum := sha256.Sum256([]byte("nem-dev-field-key-v1"))
		return map[uint16][]byte{1: sum[:]}, nil
	}
	keys := map[uint16][]byte{}
	for _, part := range strings.Split(raw, ",") {
		ver, b64, ok := strings.Cut(strings.TrimSpace(part), ":")
		v, err := strconv.ParseUint(ver, 10, 16)
		if !ok || err != nil || v == 0 {
			return nil, fmt.Errorf("%q is not <version>:<base64 key> with a version from 1", ver)
		}
		if _, dup := keys[uint16(v)]; dup {
			return nil, fmt.Errorf("version %d is listed twice", v)
		}
		key, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			return nil, fmt.Errorf("version %d is not valid base64", v)
		}
		if len(key) != 32 {
			return nil, fmt.Errorf("version %d decodes to %d bytes, need exactly 32", v, len(key))
		}
		keys[uint16(v)] = key
	}
	return keys, nil
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
