// Package config loads and validates the API's settings from environment variables.
package config

import (
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
	Env             Env
	Port            int
	LogLevel        slog.Level
	CORSOrigins     []string
	ShutdownTimeout time.Duration
}

// devOrigins are the Expo web dev server and the console's Vite dev server.
var devOrigins = []string{"http://localhost:8081", "http://localhost:5173"}

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

	if len(errs) > 0 {
		return Config{}, fmt.Errorf("invalid config: %w", errors.Join(errs...))
	}
	return cfg, nil
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
