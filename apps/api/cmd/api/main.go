// Command api runs the Nem Bank HTTP API.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/config"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/httpserver"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/logging"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
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
	log := logging.New(os.Stdout, cfg.LogLevel, version)

	// Render sends SIGTERM before it stops an instance; Ctrl+C sends SIGINT locally.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	router := httpserver.NewRouter(httpserver.Options{
		Version:     version,
		Logger:      log,
		CORSOrigins: cfg.CORSOrigins,
	})
	log.Info("starting nem api", "env", string(cfg.Env))
	return httpserver.NewServer(cfg.Addr(), router, log, cfg.ShutdownTimeout).Run(ctx)
}
