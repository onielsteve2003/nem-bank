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

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/admin"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/config"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/database"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/fieldcrypt"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/httpserver"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/idempotency"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/logging"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/mailer"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/observability"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers/partners"
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
	if len(os.Args) > 1 && os.Args[1] == "create-staff" {
		if err := createStaff(os.Args[2:]); err != nil {
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

	var mail mailer.Mailer = mailer.Log{Logger: log}
	if cfg.BrevoAPIKey != "" {
		mail = mailer.Brevo{APIKey: cfg.BrevoAPIKey, FromEmail: cfg.MailFromEmail, FromName: cfg.MailFromName}
	} else {
		log.Warn("BREVO_API_KEY not set: emails are logged, not sent")
	}
	var transfersSvc *transfers.Service
	identitySvc, err := identity.NewService(identity.Config{
		Pool: pool, Mailer: mail, Logger: log, OTPKey: cfg.OTPKey, SigningKey: cfg.JWTSigningKey,
		OnCustomerCreated: accounts.OpenCurrentAccount,
		// Set below: transfers needs identity, and identity calls back into transfers.
		OnDuressEnded: func(ctx context.Context, tx pgx.Tx, userID uuid.UUID) error {
			return transfersSvc.StopDuressTransfers(ctx, tx, userID)
		},
	})
	if err != nil {
		return err
	}
	accountsSvc, err := accounts.NewService(accounts.Config{
		Pool: pool, Customers: identitySvc, Logger: log,
		Timelines: func(ctx context.Context, id uuid.UUID) ([]api.TimelineEvent, error) {
			return transfersSvc.Timeline(ctx, id)
		},
	})
	if err != nil {
		return err
	}
	sandbox, err := partners.NewSandboxNIP(partners.SandboxConfig{
		Pool: pool, CallbackURL: cfg.SandboxNIPCallbackURL, Secret: cfg.SandboxNIPSecret, Logger: log,
	})
	if err != nil {
		return err
	}
	var partner partners.BankPartner = sandbox
	if cfg.BankPartner == "paystack_test" {
		if partner, err = partners.NewPaystack(partners.PaystackConfig{SecretKey: cfg.PaystackSecretKey}); err != nil {
			return err
		}
	}
	transfersSvc, err = transfers.NewService(transfers.Config{
		Pool: pool, Accounts: accountsSvc, Customers: identitySvc, Partner: partner, Sandbox: sandbox, Logger: log,
		WebhookSecrets: map[string][]byte{sandbox.Name(): cfg.SandboxNIPSecret},
	})
	if err != nil {
		return err
	}

	keyring, err := fieldcrypt.New(cfg.FieldKeys, cfg.FieldIndexKey)
	if err != nil {
		return err
	}
	adminSvc, err := admin.NewService(admin.Config{
		Pool: pool, Logger: log, SigningKey: cfg.StaffJWTSigningKey, Keyring: keyring,
	})
	if err != nil {
		return err
	}

	idem := idempotency.NewStore(pool)

	metrics := observability.NewMetrics()
	metrics.RegisterPool(pool)

	router, err := httpserver.NewRouter(httpserver.Options{
		Version:            version,
		Logger:             log,
		CORSOrigins:        cfg.CORSOrigins,
		ClientIPHeader:     cfg.ClientIPHeader,
		Readiness:          []httpserver.ReadinessCheck{{Name: "database", Pinger: pool}},
		Metrics:            metrics,
		MetricsToken:       cfg.MetricsToken,
		Identity:           identity.NewAPI(identitySvc),
		Authenticator:      identitySvc,
		Signatures:         identitySvc,
		PartnerCallbacks:   transfersSvc,
		Idempotency:        idem,
		Accounts:           accounts.NewAPI(accountsSvc),
		Transfers:          transfers.NewAPI(transfersSvc),
		Admin:              admin.NewAPI(adminSvc),
		StaffAuthenticator: adminSvc,
	})
	if err != nil {
		return err
	}
	log.Info("starting nem api", "env", string(cfg.Env))

	// Jobs run in-process (Render free has no worker dynos). Subscribers arrive with the
	// domains that need side effects (notify, webhooks, transfer sagas).
	runner, err := jobs.New(pool, log, jobs.Options{
		Subscribers:  []jobs.Subscriber{accountsSvc.StatementSubscriber()},
		Housekeeping: []func(context.Context) error{idem.Prune, accountsSvc.SnapshotBalances},
		Workers:      []func(*river.Workers){sandbox.Register, transfersSvc.Register},
	})
	if err != nil {
		return err
	}
	if err := runner.Start(ctx); err != nil {
		return err
	}
	serveErr := httpserver.NewServer(cfg.Addr(), router, log, cfg.ShutdownTimeout).Run(ctx)

	// HTTP is drained first, so no request can enqueue work into a stopping runner. Running
	// jobs then get the same shutdown budget; any cut off are retried after restart.
	stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cfg.ShutdownTimeout)
	defer cancel()
	if err := runner.Stop(stopCtx); err != nil {
		log.Error("stop jobs", slog.Any("error", err))
	}
	return serveErr
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
