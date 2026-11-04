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
