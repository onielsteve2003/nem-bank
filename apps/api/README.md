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
db/queries/           sqlc queries
```

Domain packages talk to each other through exported service interfaces, never through each
other's tables.

## Requirements

- Go 1.27+
- [Task](https://taskfile.dev): `go install github.com/go-task/task/v3/cmd/task@latest`
- [air](https://github.com/air-verse/air) for hot reload: `go install github.com/air-verse/air@latest`
- [golangci-lint](https://golangci-lint.run) v2 for `task lint`

## Run

```sh
cd apps/api
task dev        # hot reload on http://localhost:8080
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
