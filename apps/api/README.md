# Nem Bank API

The Go backend for Nem Bank: a modular monolith built on Gin and PostgreSQL. The HTTP contract
lives in [`packages/contracts/openapi.yaml`](../../packages/contracts/openapi.yaml).

All money is simulated. External rails run in sandbox mode.

## Layout

```
cmd/api/              entry point
internal/platform/    config, logging, HTTP server, middleware, database
internal/jobs/        River job queue, transactional outbox and its dispatcher
internal/<domain>/    one package per domain (ledger, identity, transfers, ...)
db/migrations/        goose SQL migrations
db/queries/<domain>/  sqlc queries, generated into internal/<domain>
```

Domain packages talk to each other through exported service interfaces, never through each
other's tables.

## Requirements

- Go 1.27+
- [Task](https://taskfile.dev): `go install github.com/go-task/task/v3/cmd/task@latest`
- [air](https://github.com/air-verse/air) for hot reload: `go install github.com/air-verse/air@latest`
- [golangci-lint](https://golangci-lint.run) v2 for `task lint`
- Docker, for the local Postgres
- [goose](https://github.com/pressly/goose) for the `migrate:*` tasks: `go install github.com/pressly/goose/v3/cmd/goose@latest`
- [sqlc](https://sqlc.dev) for `task generate` (on Windows, the release binary; `go install` needs cgo)

## Run

```sh
cd apps/api
task db:up      # Postgres 17 on localhost:5433
task dev        # hot reload on http://localhost:8080; applies migrations on start
curl localhost:8080/v1/health
```

## Health probes and Docker

| Path | Meaning |
|---|---|
| `GET /healthz` | Liveness: 200 while the process serves HTTP. Never checks dependencies, so a database outage does not get a healthy process restarted. |
| `GET /readyz` | Readiness: pings the database (3 s timeout). 200 when every check passes, 503 with the failing check names otherwise. Error details go to the log, not the public body. |
| `GET /v1/health` | The contract's health operation (version and server time) for app clients. |

The `Dockerfile` is multi-stage: a Go build stage with cached modules, then
`gcr.io/distroless/static-debian12:nonroot` (static binary, no shell, uid 65532).
Distroless has no curl, so `HEALTHCHECK` runs `/api healthcheck`, which probes `/healthz`.

```sh
docker build --build-arg VERSION=$(git rev-parse --short HEAD) -t nem-api apps/api
docker run --rm -p 8080:8080 -e DATABASE_URL=... -e CORS_ALLOWED_ORIGINS=https://... nem-api
```

CI builds the image on every push.

## Observability

All three are free tiers and all are optional: with nothing set, the API still runs.

- **Traces (OpenTelemetry).** `otelgin` makes a span per request and `otelpgx` one per query
  (SQL text only, never arguments). W3C `traceparent` is honoured, so a trace started by the
  app continues here. Probes and `/metrics` are not traced. Spans export over OTLP/HTTP when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- **Logs.** Every record logged with a request context carries `request_id`, `trace_id`
  and `span_id`, so a log line leads straight to its trace.
- **Metrics (Prometheus).** `GET /metrics`: `http_requests_total` and
  `http_request_duration_seconds` by route template (never raw paths), in-flight requests,
  pgx pool stats (`db_pool_*`), Go runtime and process metrics. Bearer `METRICS_TOKEN`.
- **Errors (Sentry).** Anything logged at error level (a failed request, a recovered panic)
  becomes one Sentry event, tagged with `request_id`, `route` and `code` and linked to its
  trace ID. Events are built from PII-free log records, so nothing extra leaks.

```sh
curl -H "Authorization: Bearer $METRICS_TOKEN" localhost:8080/metrics
```

`task --list` shows everything else: `run`, `build`, `test` (with `-race`), `lint`, `fmt`, `tidy`.

## Configuration

Settings come from environment variables. Copy `.env.example` to `.env` for local overrides.
The API refuses to start on a bad value and lists every problem at once.

| Variable | Default | Notes |
|---|---|---|
| `APP_ENV` | `development` | `development`, `test` or `production` |
| `PORT` | `8080` | Render sets this |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `SHUTDOWN_TIMEOUT` | `15s` | How long in-flight requests get after SIGTERM |
| `CORS_ALLOWED_ORIGINS` | Expo web + console dev servers | Exact origins, comma-separated. Required (https only) in production; no wildcards |
| `DATABASE_URL` | the docker-compose database | Required in production (Neon) |
| `DB_MAX_CONNS` | `10` | Pool size; Neon's free tier allows few connections |
| `MIGRATE_ON_START` | `true` | Apply pending migrations at boot (Render free has no pre-deploy step) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | empty | OTLP/HTTP URL for traces (Grafana Cloud free). Empty keeps spans local |
| `OTEL_EXPORTER_OTLP_HEADERS` | empty | Read by the exporter itself, e.g. `Authorization=Basic ...` |
| `TRACE_SAMPLE_RATIO` | `1` | Share of new traces kept, 0 to 1. Sampled parents are always kept |
| `SENTRY_DSN` | empty | Error tracking (Sentry free). Empty turns it off |
| `METRICS_TOKEN` | empty | Bearer token for `/metrics`. Required in production |
| `BREVO_API_KEY` | empty | Brevo (free, 300 emails/day). Empty logs emails instead of sending them. Required in production |
| `MAIL_FROM_EMAIL` / `MAIL_FROM_NAME` | `no-reply@nem.bank` / `Nem Bank` | Sender; must be verified in Brevo |
| `JWT_SIGNING_KEY` | fixed dev key | Base64 32-byte Ed25519 seed that signs access tokens. Required in production |
| `OTP_KEY` | fixed dev key | Base64, 32+ bytes (`openssl rand -base64 32`): HMAC key for stored one-time codes. Required in production |

## Database

- **pgx v5** pool. Idle connections close after 4 minutes, before Neon suspends the database,
  and startup pings with a 15-second timeout so a cold Neon database can wake.
- **goose** migrations in `db/migrations`, embedded in the binary. On start the API applies
  pending ones under a Postgres advisory lock, so two instances booting together are safe.
  `task migrate:status | migrate:up | migrate:down | migrate:new -- <name>` work on the same files.
- **sqlc** turns `db/queries/<domain>/*.sql` into typed Go in that domain's package
  (`sqlc.yaml` has one entry per domain). Edit the SQL, run `task generate`, commit both.
  No ORM: money paths stay explicit, reviewable SQL.
- The compose database listens on host port **5433**, so a Postgres installed natively on
  5432 does not get in the way. `task db:reset` wipes it.

## Identity

`internal/identity` owns customers and how they prove who they are.

- **Sign-up (AUTH-1, AUTH-2).** `POST /v1/auth/signup` checks the details (18+ in Lagos time,
  NDPA consent, email and phone not already registered) and emails a 6-digit code. The details
  wait in `signups` until the email is verified and a password is set, so an unverified
  address never becomes an account. `POST /v1/auth/otp/verify` returns a single-use
  verification token for the final step.
- **One-time codes.** Drawn from `crypto/rand`, stored only as an HMAC-SHA256 under `OTP_KEY`
  (bound to the challenge ID), so a database leak cannot be brute-forced into live codes.
  10-minute expiry, 5 attempts (counted under a row lock, so parallel guesses cannot race),
  60-second resend cooldown, 5 sends per challenge, 5 new codes per address per hour.
  Refusals are `429` with `Retry-After`.
- **Passwords (AUTH-3).** argon2id (19 MiB, t=2, p=1, OWASP's baseline) in PHC format, so the
  parameters can rise later without breaking stored hashes. A semaphore caps concurrent hashes
  so a burst of logins cannot exhaust a 512 MB instance. Strength rules are a Go port of
  `packages/shared/src/password.ts` and are tested against the same vectors, so the app's meter
  and the API agree.
- **Email.** A `mailer.Mailer` interface: Brevo's HTTP API in production, a log mailer locally
  (the code appears in the API log).
- **Sessions.** Finishing sign-up or logging in binds the device's Ed25519 public key and opens
  a session: one per device, and one refresh-token family. Access tokens are EdDSA JWTs valid
  for 10 minutes (`kid` header for key rotation; only `EdDSA` is accepted, which rules out
  `alg: none` and HS256 key confusion). Every authenticated request also checks the session row,
  so logout and device revocation work at once, not when the token expires.
- **Refresh rotation with reuse detection.** Refresh tokens are opaque 256-bit values stored as
  SHA-256. Each use spends the token and issues the next (30-day sliding expiry, 90-day cap per
  session). A spent token presented again means it was copied, so the whole session is revoked
  and an `identity.refresh_token_reused` event goes to the outbox. The token row is locked, so
  two refreshes racing with one token cannot both win.
- **Login (AUTH-7, AUTH-8).** Email or phone (`+234…` or local `080…`) plus password. Unknown
  accounts are checked against a dummy argon2id hash, so timing does not reveal who has an
  account. A login that binds a new device sets a 24-hour `cool_off_until` and writes
  `identity.device_bound` to the outbox for the alert to the other devices.
- **Transaction PIN (AUTH-4).** Set at sign-up or once with `PUT /v1/users/me/pin`; argon2id.
  Weak PINs (repeats, runs, birthday forms) are refused with the same rules as
  `packages/shared/src/pin.ts`. Five wrong tries lock it for 30 minutes, then 2 h, 8 h and 24 h
  for each lockout in a row; a correct PIN resets the count. The user row is locked through
  the check, so parallel guesses cannot skip the counter. Changing the PIN later needs a
  `pin_reset` step-up token (see Step-up below).
- **Duress PIN (SEC-5).** Verifies exactly like the real PIN (same response; both hashes are
  always checked, so timing matches too), switches the account into duress mode and writes
  `security.duress_triggered` to the outbox for staff only. While in duress, attempts to
  remove the duress PIN or reset the PIN report success but change nothing. The real PIN ends
  duress mode. `InDuress` is what transfers and balances will read.
- **Step-up.** `POST /v1/auth/step-up` starts a fresh check for one purpose (`pin_reset`,
  `card_reveal`, `transfer`, ...) and emails a code; `.../{step_up_id}/verify` takes any one
  proof: the PIN, the email code, or a device signature (Face ID unlocks the Ed25519 key and
  signs the `step_up_id`; checked against the device's bound key). The token lasts 5 minutes,
  works once, and only for its purpose. The step-up is itself an email-code challenge, so the
  app's "send again" uses `/v1/auth/otp/resend` unchanged. Error codes match the app's mock
  bank (`invalid_pin`, `pin_locked`, `invalid_otp`, `invalid_signature`, `otp_expired`).
  10 step-ups per customer per hour.
- **Bearer auth** is enforced by the request validator from each operation's `security`: a
  missing or bad token is a `401` with `WWW-Authenticate`, before any body validation.

## Jobs and the outbox

Background work runs on [River](https://riverqueue.com), a job queue stored in the same
Postgres, inside the API process (Render's free tier has no worker dynos). River's schema is
applied at boot after the goose migrations.

Side effects of a state change (pushes, emails, webhooks, saga steps) go through a
**transactional outbox** (`outbox_events`):

1. The domain calls `jobs.Write(ctx, tx, event)` in the **same transaction** as its change,
   so the event exists exactly when the change committed.
2. The dispatcher claims pending rows with `FOR UPDATE SKIP LOCKED` (several instances can
   run it at once) and, in one transaction, inserts one River job per (event, subscriber)
   and marks the rows dispatched. A crash anywhere leaves the batch pending.
3. River runs each delivery with retries and backoff. Delivery is at-least-once, so
   subscribers are idempotent on the event ID; jobs are unique per (event, subscriber).

An hourly River periodic job prunes dispatched events older than 7 days. On SIGTERM, HTTP
drains first, then running jobs get the shutdown budget; anything cut off is retried.

## Tests

`task test` runs everything with the race detector (needs cgo, so on Windows without gcc use
`go test ./...`; CI always runs `-race`).

- **Database tests** call `testdb.New(t)` (`internal/platform/testdb`) and get their own
  database at the latest migration, dropped when the test ends, so they can run with
  `t.Parallel()`. Migrations run once into a template database named after a hash of the
  migration files; each test clones it with `CREATE DATABASE ... TEMPLATE` in milliseconds.
  Postgres comes from testcontainers-go (one container per test binary, Docker required), or
  from `TEST_DATABASE_URL` when set, which is faster on a running compose database:
  `TEST_DATABASE_URL=postgres://nem:nem@localhost:5433/nem?sslmode=disable go test ./...`.
  Without Docker the database tests skip locally; in CI they fail.
- **Fixtures** are plain SQL files in a package's `testdata/`, applied in order in one
  transaction: `testdb.Load(t, pool, os.DirFS("testdata"), "users.sql", "accounts.sql")`.
- **CI** (`API (Go)` job): the generated server must match the contract, golangci-lint,
  `go test -race`, and govulncheck.

## Request pipeline

Request ID → access log → panic recovery → CORS → handler.

- Every response carries `X-Request-Id`. A well-formed ID from the caller is kept, so the app
  and the API log the same ID; otherwise the API generates a UUIDv7.
- Logs are JSON (`log/slog`) with the request ID on every line logged with the request
  context. The access log records the route template, never the raw path or query, so account
  numbers and emails stay out of logs.
- A panic becomes a logged stack trace and a `500 application/problem+json`; the client never
  sees the panic value.
- **Contract-first.** `task generate` runs oapi-codegen (pinned as a Go `tool` in `go.mod`) on
  the contract to produce `internal/api/api.gen.go`: request/response models and a Gin strict
  server, one typed method per operation. It also writes `unimplemented.gen.go`, an
  `Unimplemented` base that answers every operation with `501 not_implemented`, so a new
  operation in the contract compiles at once and each domain overrides its methods as it is built.
- **Request validation.** Before any handler runs, the request is checked against the embedded
  spec (kin-openapi `openapi3filter`): path, query and header parameters and the JSON body,
  including OpenAPI 3.1 `type: [string, 'null']`. Failures return one `400 validation_failed`
  problem with a field error per violation: body fields as JSON Pointers (`/last_name`),
  parameters as `query.limit`. Messages describe the rule (`Must be at most 100.`) and never
  repeat the submitted value, because values can be PII. Authentication is enforced separately.
- On SIGTERM or Ctrl+C the server stops accepting connections and lets in-flight requests
  finish within `SHUTDOWN_TIMEOUT`.

## Errors and pagination

- **Errors** are RFC 9457 `application/problem+json` (`internal/platform/problem`) with a stable
  `code` and `type: https://nem.bank/problems/<code>`, the same shape the app's mock bank
  produces. Domains declare sentinels such as
  `ErrInsufficientFunds = problem.New(422, "insufficient_funds", "...")`, wrap them with `%w` as
  they travel up, and add specifics with `WithDetail` (copies, so sentinels stay shared and
  `errors.Is` still matches). `problem.Write` renders the first `*problem.Error` in the chain;
  anything else is logged with its cause and sent as an opaque `500 internal_error`. A deadline
  becomes `504 timeout`; a client that hung up gets nothing. `RetryAt` sets `Retry-After`.
- **Pagination** (`internal/platform/pagination`) is keyset, not offset: the cursor is an opaque
  base64url `(time, id)` position, versioned, so pages never skip or repeat rows when new ones
  arrive and every page is an index range scan. Fetch `limit + 1` rows; `pagination.Page`
  trims the extra row and sets `next_cursor` (null on the last page). A cursor the server did
  not issue is a `400` on `query.cursor`.
