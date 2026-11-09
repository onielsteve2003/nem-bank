// Command api runs the Nem Bank HTTP API.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/config"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/database"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/httpserver"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/logging"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/observability"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	// The distroless image has no shell or curl, so Docker's HEALTHCHECK runs the binary
	// itself: `api healthcheck` probes /healthz on the local port and exits 0 or 1.
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		if err := healthcheck(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}

	flushSentry, err := observability.SetupSentry(observability.SentryConfig{
		DSN: cfg.SentryDSN, Version: version, Environment: string(cfg.Env),
	})
	if err != nil {
		return err
	}
	defer flushSentry()
	log := logging.New(os.Stdout, cfg.LogLevel, version, func(h slog.Handler) slog.Handler {
		return observability.NewSentryHandler(h, nil)
	})

	// Render sends SIGTERM before it stops an instance; Ctrl+C sends SIGINT locally.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Before the pool opens, so the pgx tracer picks up the real provider.
	shutdownTracing, err := observability.SetupTracing(ctx, observability.TracingConfig{
		Endpoint: cfg.OTLPEndpoint, SampleRatio: cfg.TraceSampleRatio,
		Version: version, Environment: string(cfg.Env),
	})
	if err != nil {
		return err
	}
	defer func() {
		// The signal context is already cancelled here; give the exporter its own deadline.
		flushCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if err := shutdownTracing(flushCtx); err != nil {
			log.Warn("flush traces", "error", err.Error())
		}
	}()

	pool, err := database.Open(ctx, cfg.DatabaseURL, cfg.DBMaxConns)
	if err != nil {
		return err
	}
	defer pool.Close()
	if cfg.MigrateOnStart {
		if err := database.Migrate(ctx, pool, log); err != nil {
			return err
		}
	}

	metrics := observability.NewMetrics()
	metrics.RegisterPool(pool)

	router, err := httpserver.NewRouter(httpserver.Options{
		Version:      version,
		Logger:       log,
		CORSOrigins:  cfg.CORSOrigins,
		Readiness:    []httpserver.ReadinessCheck{{Name: "database", Pinger: pool}},
		Metrics:      metrics,
		MetricsToken: cfg.MetricsToken,
	})
	if err != nil {
		return err
	}
	log.Info("starting nem api", "env", string(cfg.Env))
	return httpserver.NewServer(cfg.Addr(), router, log, cfg.ShutdownTimeout).Run(ctx)
}

func healthcheck() error {
	// Same PORT the server reads; parsed to a number so the probe can only ever hit loopback.
	port := 8080
	if v := os.Getenv("PORT"); v != "" {
		p, err := strconv.Atoi(v)
		if err != nil || p < 1 || p > 65535 {
			return fmt.Errorf("healthcheck: PORT %q is not a port number", v)
		}
		port = p
	}
	url := "http://127.0.0.1:" + strconv.Itoa(port) + httpserver.LivenessPath
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil) //nolint:gosec // loopback host, numeric port: not caller-controlled
	if err != nil {
		return fmt.Errorf("healthcheck: %w", err)
	}
	resp, err := http.DefaultClient.Do(req) //nolint:gosec // same loopback request as above
	if err != nil {
		return fmt.Errorf("healthcheck: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("healthcheck: status %d", resp.StatusCode)
	}
	return nil
}
