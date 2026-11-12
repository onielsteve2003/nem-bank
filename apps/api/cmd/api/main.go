// Command api runs the Nem Bank HTTP API.
package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"slices"
	"strconv"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/admin"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ajo"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/assistant"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/assistant/assistantdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/bills"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/cards"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/categorize"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/console"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/credit"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/demo"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/developer"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/family"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/forecast"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/forecast/forecastdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/fx"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/kyc"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/limits"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/notify"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/panicmode"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/config"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/database"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/fieldcrypt"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/httpserver"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/idempotency"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/logging"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/mailer"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/observability"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/privacy"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/realtime"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/risk"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/savings"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/scam"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/support"
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
	limitsSvc, err := limits.NewService(limits.Config{Pool: pool, Customers: identitySvc, StepUps: identitySvc})
	if err != nil {
		return err
	}
	// The QR key is derived from the token signing seed under its own label, so no second
	// secret has to be provisioned and neither key reveals the other.
	qrMAC := hmac.New(sha256.New, cfg.JWTSigningKey)
	qrMAC.Write([]byte("nem receive-qr signing key v1"))
	var riskSvc *risk.Service
	if cfg.RiskMode != "off" {
		if riskSvc, err = risk.NewService(risk.Config{Mode: risk.Mode(cfg.RiskMode), Logger: log}); err != nil {
			return err
		}
	}
	transfersSvc, err = transfers.NewService(transfers.Config{
		Risk:  riskSvc,
		QRKey: qrMAC.Sum(nil),
		Pool:  pool, Accounts: accountsSvc, Customers: identitySvc, Limits: limitsSvc, StepUps: identitySvc, Partner: partner, Sandbox: sandbox, Logger: log,
		WebhookSecrets: map[string][]byte{sandbox.Name(): cfg.SandboxNIPSecret},
	})
	if err != nil {
		return err
	}

	fxSvc, err := fx.NewService(fx.Config{
		Pool: pool, Accounts: accountsSvc, Customers: identitySvc, Limits: limitsSvc, Logger: log,
		// open.er-api.com has the naira; Frankfurter (ECB) is the fallback for the majors.
		Sources: []fx.RatesSource{fx.NewOpenERAPI("", nil), fx.NewFrankfurter("", nil)},
	})
	if err != nil {
		return err
	}

	keyring, err := fieldcrypt.New(cfg.FieldKeys, cfg.FieldIndexKey)
	if err != nil {
		return err
	}
	// Smart categories (AI-3). If the model will not load, the dictionary still works.
	categorizer, err := categorize.New()
	if err != nil {
		log.Error("category model failed to load; the merchant dictionary decides alone", "error", err)
		if categorizer, err = categorize.DictionaryOnly(); err != nil {
			return err
		}
	}
	cardsSvc, err := cards.NewService(cards.Config{
		Categorizer: categorizer,
		Pool:        pool, Accounts: accountsSvc, Customers: identitySvc, StepUps: identitySvc, Keyring: keyring, Rates: fxSvc, Logger: log,
	})
	if err != nil {
		return err
	}
	// The simulated biller is the default rail (BILL-4); an adapter for a real aggregator
	// replaces it here without touching the payment flow.
	billsSvc, err := bills.NewService(bills.Config{
		Pool: pool, Accounts: accountsSvc, Customers: identitySvc, Limits: limitsSvc, Biller: bills.Simulated{}, Logger: log,
	})
	if err != nil {
		return err
	}
	savingsSvc, err := savings.NewService(savings.Config{Pool: pool, Accounts: accountsSvc, Logger: log})
	if err != nil {
		return err
	}
	ajoSvc, err := ajo.NewService(ajo.Config{Pool: pool, Accounts: accountsSvc, Customers: identitySvc, Logger: log})
	if err != nil {
		return err
	}
	scamSvc, err := scam.NewService(scam.Config{
		// A Nem account is one we hold; whether other banks' accounts exist is the bank partner's
		// to say, so they stay "unknown". Customer reports of accounts arrive with support (T30.3).
		KnownAccount: func(ctx context.Context, number string) (bool, error) {
			_, err := accountsSvc.ResolveNuban(ctx, number)
			if errors.Is(err, accounts.ErrNoSuchNuban) {
				return false, nil
			}
			return err == nil, err
		},
	})
	if err != nil {
		return err
	}
	creditSvc, err := credit.NewService(credit.Config{Pool: pool, Accounts: accountsSvc, Customers: identitySvc, Scorer: credit.DefaultScorer(log), Logger: log})
	if err != nil {
		return err
	}
	forecastSvc, err := forecast.NewService(forecast.Config{Queries: forecastdb.New(pool), Accounts: accountsSvc, Customers: identitySvc})
	if err != nil {
		return err
	}
	// Language models, free tiers only. A missing key just leaves that provider out; with none
	// the assistant answers 503 and the app falls back to its shortcuts.
	var llm []assistant.Provider
	if cfg.GeminiAPIKey != "" {
		llm = append(llm, &assistant.Gemini{APIKey: cfg.GeminiAPIKey, Model: cfg.GeminiModel})
	}
	if cfg.GroqAPIKey != "" {
		llm = append(llm, &assistant.Groq{APIKey: cfg.GroqAPIKey, Model: cfg.GroqModel})
	}
	if len(llm) == 0 {
		log.Warn("GEMINI_API_KEY and GROQ_API_KEY not set: Nem Assistant is switched off")
	}
	assistantSvc, err := assistant.NewService(assistant.Config{
		Store: assistantdb.New(pool), Gateway: assistant.NewGateway(llm...), Accounts: accountsSvc, Forecast: forecastSvc,
		Beneficiaries: assistant.BeneficiariesFrom(transfersSvc), Cards: assistant.CardsFrom(cardsSvc), Customers: identitySvc, Logger: log,
	})
	if err != nil {
		return err
	}
	// Identity checks run against the free sandbox provider; documents are stored encrypted in
	// Postgres. ID prefill reads the same store, and only for uploads matching a sample hash.
	kycSvc, err := kyc.NewService(kyc.Config{
		Pool: pool, Identifiers: kyc.NewIdentifiers(keyring), Keyring: keyring, Limits: limitsSvc,
		SampleHashes: cfg.KYCSampleIDHashes, Logger: log,
	})
	if err != nil {
		return err
	}
	prefill := kyc.NewPrefiller(kyc.PrefillConfig{Gateway: assistant.NewGateway(llm...), Documents: kycSvc})
	adminSvc, err := admin.NewService(admin.Config{
		Pool: pool, Logger: log, SigningKey: cfg.StaffJWTSigningKey, Keyring: keyring,
	})
	if err != nil {
		return err
	}

	hub := realtime.NewHub(nil)
	realtimeSvc, err := realtime.New(realtime.Config{Hub: hub, Logger: log, AllowedOrigins: cfg.CORSOrigins})
	if err != nil {
		return err
	}

	// Inbox, preferences, Expo push (free) and email. A missing mail key falls back to the log
	// mailer above, so notification emails are logged, not sent, in local runs.
	notifySvc, err := notify.NewService(notify.Config{Pool: pool, Mailer: mail, Hub: hub, Pusher: notify.Expo{}, Logger: log})
	if err != nil {
		return err
	}

	// Attachment links are signed with a key derived from the token signing seed under its own
	// label, like the QR key, so no new secret has to be provisioned.
	filesMAC := hmac.New(sha256.New, cfg.JWTSigningKey)
	filesMAC.Write([]byte("nem attachment link signing key v1"))
	supportSvc, err := support.NewService(support.Config{Pool: pool, FilesKey: filesMAC.Sum(nil), Hub: hub, Logger: log})
	if err != nil {
		return err
	}

	// Setup codes for dependants are kept under a key derived from the token signing seed under
	// its own label, like the QR and attachment keys.
	codeMAC := hmac.New(sha256.New, cfg.JWTSigningKey)
	codeMAC.Write([]byte("nem dependant setup code key v1"))
	familySvc, err := family.NewService(family.Config{
		Pool: pool, Accounts: accountsSvc, Customers: identitySvc, StepUps: identitySvc, Sender: transfersSvc,
		Limits: limitsSvc, CodeKey: codeMAC.Sum(nil), Logger: log,
	})
	if err != nil {
		return err
	}
	// A dependant's transfers answer to their parent's controls.
	transfersSvc.SetFamily(familySvc)

	// The staff console's cross-domain operations. KYC photo links are signed with a key derived
	// from the token signing seed under its own label, like the QR and attachment keys. Starting
	// it also registers the maker-checker actions, so it must come before the first request.
	reviewMAC := hmac.New(sha256.New, cfg.JWTSigningKey)
	reviewMAC.Write([]byte("nem kyc review link signing key v1"))
	consoleSvc, err := console.NewService(console.Config{
		Pool: pool, Admin: adminSvc, KYC: kycSvc, Support: supportSvc, Transfers: transfersSvc, Accounts: accountsSvc,
		Identity: identitySvc, FX: fxSvc, Limits: limitsSvc, LinkKey: reviewMAC.Sum(nil), Logger: log,
	})
	if err != nil {
		return err
	}
	// What staff approved stays in force across restarts.
	if err := consoleSvc.ApplyLive(ctx); err != nil {
		return err
	}

	// API keys, webhooks (signed with encrypted per-endpoint secrets) and the sandbox payer.
	developerSvc, err := developer.NewService(developer.Config{
		Pool: pool, Keyring: keyring, StepUps: identitySvc, Transfers: transfersSvc, Logger: log,
	})
	if err != nil {
		return err
	}

	// Data export and account deletion. Download links are signed with a key derived from the token
	// signing seed under its own label, like the other link keys.
	privacyMAC := hmac.New(sha256.New, cfg.JWTSigningKey)
	privacyMAC.Write([]byte("nem privacy export link signing key v1"))
	demoSvc, err := demo.NewService(demo.Config{Pool: pool, Identity: identitySvc, Rules: limitsSvc, KYC: kycSvc, Advancers: []demo.Advancer{savingsSvc, transfersSvc, creditSvc, ajoSvc}})
	if err != nil {
		return err
	}
	sandbox.SetForceFail(demoSvc.ConsumeFailNext)
	kycSvc.SetAfterSubmit(demoSvc.AutoReview)
	panicSvc, err := panicmode.NewService(panicmode.Config{Pool: pool, StepUps: identitySvc})
	if err != nil {
		return err
	}
	privacySvc, err := privacy.NewService(privacy.Config{
		Pool: pool, Keyring: keyring, Mailer: mail, StepUps: identitySvc, PublicURL: cfg.PublicURL, LinkKey: privacyMAC.Sum(nil), Logger: log,
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
		Realtime:           realtimeSvc,
		Limits:             limits.NewAPI(limitsSvc),
		FX:                 fx.NewAPI(fxSvc),
		Cards:              cards.NewAPI(cardsSvc),
		Bills:              bills.NewAPI(billsSvc),
		Savings:            savings.NewAPI(savingsSvc),
		Ajo:                ajo.NewAPI(ajoSvc),
		Credit:             credit.NewAPI(creditSvc),
		Scam:               scam.NewAPI(scamSvc),
		Forecast:           forecast.NewAPI(forecastSvc),
		Assistant:          assistant.NewAPI(assistantSvc),
		KYCPrefill:         kyc.NewPrefillAPI(prefill),
		KYC:                kyc.NewAPI(kycSvc),
		Support:            support.NewAPI(supportSvc),
		Notify:             notify.NewAPI(notifySvc),
		Family:             family.NewAPI(familySvc),
		Admin:              admin.NewAPI(adminSvc),
		Console:            console.NewAPI(consoleSvc),
		Developer:          developer.NewAPI(developerSvc),
		Privacy:            privacy.NewAPI(privacySvc),
		Panic:              panicmode.NewAPI(panicSvc),
		Demo:               demo.NewAPI(demoSvc),
		KeyAuthenticator:   developerSvc,
		StaffAuthenticator: adminSvc,
	})
	if err != nil {
		return err
	}
	log.Info("starting nem api", "env", string(cfg.Env))

	// Jobs run in-process (Render free has no worker dynos). Subscribers arrive with the
	// domains that need side effects (notify, webhooks, transfer sagas).
	runner, err := jobs.New(pool, log, jobs.Options{
		Subscribers:  []jobs.Subscriber{accountsSvc.StatementSubscriber(), transfersSvc.RealtimeSubscriber(hub), fxSvc.RealtimeSubscriber(hub), cardsSvc.RealtimeSubscriber(hub), savingsSvc.Subscriber(), notifySvc.Subscriber(), kycSvc.RealtimeSubscriber(hub), supportSvc.RealtimeSubscriber(hub), developerSvc.Subscriber(), panicSvc.RealtimeSubscriber(hub)},
		Housekeeping: []func(context.Context) error{idem.Prune, accountsSvc.SnapshotBalances, fxSvc.Prune, privacySvc.Prune, privacySvc.PurgeDemo},
		Workers:      []func(*river.Workers){sandbox.Register, transfersSvc.Register, fxSvc.Register, cardsSvc.Register, billsSvc.Register, savingsSvc.Register, ajoSvc.Register, creditSvc.Register, familySvc.Register, developerSvc.Register, privacySvc.Register},
		Periodic:     slices.Concat(transfersSvc.PeriodicJobs(), fxSvc.PeriodicJobs(), cardsSvc.PeriodicJobs(), billsSvc.PeriodicJobs(), savingsSvc.PeriodicJobs(), ajoSvc.PeriodicJobs(), creditSvc.PeriodicJobs(), familySvc.PeriodicJobs()),
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
