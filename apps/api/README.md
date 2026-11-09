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
| `CLIENT_IP_HEADER` | empty | Header the host's proxy sets to the caller's address (e.g. `CF-Connecting-IP`), for per-address rate limits. Empty uses the TCP peer; `X-Forwarded-For` is never trusted as sent |
| `SENTRY_DSN` | empty | Error tracking (Sentry free). Empty turns it off |
| `METRICS_TOKEN` | empty | Bearer token for `/metrics`. Required in production |
| `BREVO_API_KEY` | empty | Brevo (free, 300 emails/day). Empty logs emails instead of sending them. Required in production |
| `MAIL_FROM_EMAIL` / `MAIL_FROM_NAME` | `no-reply@nem.bank` / `Nem Bank` | Sender; must be verified in Brevo |
| `JWT_SIGNING_KEY` | fixed dev key | Base64 32-byte Ed25519 seed that signs access tokens. Required in production |
| `STAFF_JWT_SIGNING_KEY` | fixed dev key | A different 32-byte Ed25519 seed for console (staff) tokens; refused if it equals `JWT_SIGNING_KEY`. Required in production |
| `FIELD_ENCRYPTION_KEYS` | fixed dev key | `1:<base64 32 bytes>,2:<...>`: AES-256 keys by version for BVN/NIN/ID numbers; the highest encrypts. Keep old versions until `Rewrap` reports 0. Required in production |
| `FIELD_INDEX_KEY` | fixed dev key | Base64, 32+ bytes: HMAC key for the blind indexes (one owner per BVN). Never rotated with the field keys. Required in production |
| `OTP_KEY` | fixed dev key | Base64, 32+ bytes (`openssl rand -base64 32`): HMAC key for stored one-time codes. Required in production |
| `BANK_PARTNER` | `sandbox_nip` | Interbank rail: `sandbox_nip` (simulated NIP: delays, failures, timeouts and signed callbacks, tuned from the console's Bank Partner Simulator) or `paystack_test` (Paystack test mode) |
| `PAYSTACK_SECRET_KEY` | empty | Paystack **test** key (`sk_test_…`), required for `paystack_test`. A live key is refused |
| `SANDBOX_NIP_WEBHOOK_SECRET` | fixed dev key | Base64, 32+ bytes: HMAC secret the sandbox signs callbacks with and the partner webhook verifies. Required in production |
| `SANDBOX_NIP_CALLBACK_URL` | loopback | Where the sandbox posts callbacks; default `http://127.0.0.1:$PORT/v1/partner-webhooks/sandbox_nip` |

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
- **Device-signed requests (AUTH-6).** Every operation whose contract lists
  `X-Device-Signature` (transfers, conversions, bill payments, savings moves, ...) is checked
  by the validator once auth and the contract pass. The signature is Ed25519 over
  `METHOD\npath?query\ntimestamp\nnonce\nhex(sha256(body))`, hashed over the body bytes as they
  arrived, the same string as `signingPayload` in the app. It must come from the device of the
  caller's own session, be timestamped within ±5 minutes, and carry a nonce that device has
  not used (`signed_request_nonces`; a row lives until its timestamp leaves the window and the
  device clears its expired rows on its next signature). A nonce is stored only after the
  signature checks out. Failures are `403 invalid_signature`, not 401: the session is fine,
  and the app refreshes and retries on any 401, which would ask for Face ID twice.
- **Quick login (AUTH-5).** `POST /v1/auth/device-challenge` gives a bound device a random
  nonce (2 minutes); `POST /v1/auth/login/device` opens a session when the device key signed
  it. One attempt per challenge: a wrong signature spends it too.
- **New-device cool-off (AUTH-8).** A login that binds a new device sets `cool_off_until` to
  24 hours ahead and alerts the other devices. While it runs, `identity.CoolOff` reports a
  ₦50,000 daily cap and the risk reason `new_device`, which the limits and risk engines (M25)
  apply as the mock bank does: the lowest of that, the KYC cap and the customer's own limit,
  and a step-up on every transfer from that device. The sign-up device has no cool-off.
- **Rate limits.** In-memory GCRA (`internal/platform/ratelimit`: one timestamp per key, a
  burst of N then one every window/N). Exact on one instance, which is what Render free runs;
  more instances would need a shared store behind the same call. Per address before
  validation: 600/min on every contract route, plus tighter per-route budgets on the public
  routes that check a secret or send email (login and device login 10/min, code checks
  10/min, sign-up 20/h, password reset 10/h, ...). Per customer once authenticated: 300/min,
  and 30/min on each money-moving route, checked before the signature so a flood never writes
  nonces. `429 rate_limited` with `Retry-After`. The domains' own limits (codes, PIN lockout,
  step-ups) stay underneath. The address is the TCP peer, or `CLIENT_IP_HEADER` when the host
  sets one; `X-Forwarded-For` is ignored because a caller could set it.
- **Bearer auth** is enforced by the request validator from each operation's `security`: a
  missing or bad token is a `401` with `WWW-Authenticate`, before any body validation.

## Staff realm and maker-checker

Bank staff are a separate realm from customers (`internal/admin`): their own `staff` table,
sessions, signing key and token audience (`console`). A customer token gets a 401 on every
`/v1/admin` route, and a staff token gets a 401 on every customer route.

- **Login is always two steps (ADM-1).** `POST /v1/admin/auth/login` checks the password
  (argon2id) and returns a 5-minute challenge. `POST /v1/admin/auth/totp` takes a 6-digit
  RFC 6238 code (HMAC-SHA1, 30 s, one step of clock skew) and returns an 8-hour session with
  no refresh. The first login also returns an `otpauth://` URI to scan. Each time step works
  once, five wrong codes end the challenge, and the TOTP secret is AES-256-GCM encrypted.
- **Accounts are created by an operator**, never through the API, so a stolen console
  session cannot create another insider:
  `STAFF_PASSWORD='...' go run ./cmd/api create-staff -name "Aisha Bello" -email aisha@nem.bank -roles compliance`
- **RBAC comes from the contract.** The validator reads each operation's `x-roles` and returns
  403 unless the caller holds one of them. The console hides pages from the same list. Roles
  are loaded from the database on every request, so removing a role works at once.
- **Maker-checker (ADM-10).** A domain registers an action (`RegisterAction`) with an
  `Apply` function and, optionally, the roles allowed to approve it. `Propose` records a
  request inside the domain's own transaction. `Approve` locks the request, refuses the maker
  (403 `same_staff`, also a database CHECK), an expired request (409 `approval_expired`, after
  72 hours) or the wrong role, then runs `Apply` and closes the request in **one
  transaction**. If the change fails, the request stays pending. The approval and the change
  are written to the audit log. The same checker sending the same decision again gets the
  same answer and nothing is applied twice.

## Ledger

Double-entry, in signed integer minor units (credits positive, debits negative), in
`ledger_accounts`, `journal_entries` and `postings` (migration 00009). The database
enforces the rules itself, so a bug above it fails the transaction instead of corrupting
money:

- At COMMIT, a deferred constraint trigger checks that every entry has at least two
  postings and **nets to zero in each currency**. A conversion therefore has to go through
  the per-currency FX position accounts.
- A composite foreign key keeps each posting in its account's currency.
- Entries and postings are append-only (corrections are reversing entries), and postings
  can only be added in the transaction that created their entry.
- No customer deposit account goes below zero, `available ≤ balance`, one account per kind
  and currency per customer, and a `manual_adjustment` needs a maker-checker approval.
- The bank's own accounts are seeded with fixed IDs: suspense, fee income, FX position,
  partner settlement and demo funding in NGN, USD, GBP and EUR; card settlement in NGN and
  USD; interest expense, interest income, the EMTL levy and ajo escrow in NGN.

`internal/ledger/money` is the only way the API handles an amount: `int64` minor units plus
a currency. Mixing currencies is an error, and so is any result past `int64` (no
wrap-around). Anything that can leave a fraction takes an explicit `Rounding` (`HalfUp`,
`Floor` and `Ceil` match `@nem/shared`; `HalfEven` is for interest). `Allocate` and `Split`
use the largest-remainder method, so the shares always add back up to the total. JSON is
the contract's `{"amount_minor": "150000", "currency": "NGN"}`, read strictly. Native fuzz
tests check these invariants against `math/big`:
`go test -run '^$' -fuzz FuzzAllocate ./internal/ledger/money` (also `FuzzMulDiv`,
`FuzzParseMajor`, `FuzzJSON`, `FuzzAddSub`).

## Accounts

`internal/accounts` is what a customer sees around the ledger (migration 00012):

- **NGN account at sign-up.** Completing sign-up opens the ledger account and its customer
  record in the same transaction, so nobody exists without one. The number is a real
  **NUBAN**: a nine-digit serial from a sequence plus the CBN check digit (weights
  3-7-3 over the six-digit bank code and serial), on the fictitious bank code `090999`.
- **Wallets.** USD, GBP and EUR wallets need KYC Tier 2. Their receiving details are
  simulated and flagged `demo: true`; the EUR one is a German-format IBAN with correct
  ISO 13616 mod-97 check digits.
- **Balances** come straight from the ledger's cached balances; holds explain the gap
  between ledger and available. The NGN account shows the tier's balance cap.
- **History** is a `transactions` table: one line per account per movement, written by the
  domain that posts the entry, in the same transaction (`accounts.Record`). Its balance
  after comes from the entry's own posting. The list is keyset paged on
  `(created_at, id)`; filters by account, type, currency, status, category and Lagos
  dates; search matches narration, counterparty and reference literally (`%` and `_` are
  escaped).
- **Duress** (SEC-5): balances show the decoy (at most ₦3,850, empty wallets), history
  only small naira lines, with no running balance that would give the decoy away.
- **Statements** (migration 00013). A request is checked against the app's period rules
  (Lagos days, up to 12 months, nothing in the future), stored as `generating` and
  published to the outbox in one transaction; a subscriber builds it from the ledger's
  postings (opening = the balance just before the period, each line's running balance
  re-added and checked) and renders it with maroto. Every page carries the demo
  disclaimer, the SHA-256 of the statement's canonical content and a QR code to the public
  verification page (`GET /v1/public/statements/{code}`, masked name and number only). The
  PDF is stored as issued, so a download is the document that was verified.
- **End-of-day balances** (`daily_balances`): an hourly, idempotent catch-up fills any
  missing day of the last week, so a server that slept through midnight still records it.
  Postings are timed with `clock_timestamp()` under the account lock, so "the last posting
  before midnight" is always the latest balance.

## Transfers

`internal/transfers` (migration 00014). A transfer is a state machine,
`created → risk_checked → processing → completed | failed → reversed` plus
`pending_step_up`, `delayed`, `held_for_review`, `rejected` and `cancelled`. Every step
is a row in the append-only `transfer_events` timeline. The allowed moves live in Go
(`CanMove`) and again in a trigger that refuses any other `UPDATE` of the status. A test
tries all 121 pairs against the trigger to prove the two tables agree.

The internal rail (Nem to Nem, by account number) is instant: the transfer, its
timeline, the journal entry and both customers' transaction lines commit in **one
database transaction**, so a transfer is either completed with the money moved or never
happened. A refused transfer (insufficient funds, own account, unknown number, a wallet
as the source) leaves no row behind. A double tap with the same `Idempotency-Key`
replays the first response. Under duress (SEC-5) a transfer looks sent but moves
nothing, and the real PIN marks it "Stopped by Nem" in the same transaction that ends
duress. Other banks and saved beneficiaries answer 501 until their rails exist.

## Field encryption and the audit log

- **Identity numbers** (`internal/kyc`, `kyc_identifiers`): BVN, NIN and ID document numbers
  are encrypted per field with AES-256-GCM (`internal/platform/fieldcrypt`). The ciphertext
  carries its key version, and is bound to its owner and kind as associated data, so a
  ciphertext copied onto another customer's row does not decrypt. A keyed HMAC blind index
  enforces one customer per BVN and per NIN without decrypting anything, and `last4` is what
  screens show. Rotation: add a key version, run `Identifiers.Rewrap` until it returns 0,
  then drop the old version. Plaintext only exists in memory for the KYC provider check and
  the step-up-gated reveal (T30.2).
- **Audit log** (`internal/audit`, `audit_log`): append-only (triggers refuse UPDATE, DELETE
  and TRUNCATE) and hash-chained: each entry's hash is SHA-256 over the previous hash and
  the entry's canonical JSON, byte for byte the console's scheme
  (`apps/console/src/data/mock/audit.ts`; a Go test pins a hash computed by that code).
  `Verify` recomputes a range and names the first broken entry. Entries are written in the
  same transaction as the change they record, serialised by an advisory lock. Today:
  `device.bind`, `device.revoke`, `pin.reset`, `duress_pin.set`, `duress_pin.remove`,
  `session.token_reuse`, `security.duress_triggered`; staff actions join with T23.7.
  Metadata holds IDs only. A chain cannot show rows cut from its end, so the head hash should
  also be recorded outside the database (T32).

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
