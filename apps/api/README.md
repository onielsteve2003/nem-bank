# Nem Bank API

The Go backend for Nem Bank: a modular monolith built on Gin and PostgreSQL. The HTTP contract
lives in [`packages/contracts/openapi.yaml`](../../packages/contracts/openapi.yaml).

All money is simulated. External rails run in sandbox mode.

## Layout

```
cmd/api/              entry point
internal/platform/    config, logging, HTTP server, middleware, database
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
- `TEST_DATABASE_URL=postgres://nem:nem@localhost:5433/nem?sslmode=disable go test ./internal/platform/database/`
  runs the database test against it.

## Request pipeline

Request ID → access log → panic recovery → CORS → handler.

- Every response carries `X-Request-Id`. A well-formed ID from the caller is kept, so the app
  and the API log the same ID; otherwise the API generates a UUIDv7.
- Logs are JSON (`log/slog`) with the request ID on every line logged with the request
  context. The access log records the route template, never the raw path or query, so account
  numbers and emails stay out of logs.
- A panic becomes a logged stack trace and a `500 application/problem+json`; the client never
  sees the panic value.
- On SIGTERM or Ctrl+C the server stops accepting connections and lets in-flight requests
  finish within `SHUTDOWN_TIMEOUT`.
