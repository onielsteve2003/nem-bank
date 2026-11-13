# Load and crash-recovery tests (T32.2)

Both run against a real API and the compose Postgres. Neither is part of CI.

## Setup

```sh
cd apps/api
task db:up
go build -o bin/api.exe ./cmd/api        # bin/api on macOS and Linux
DATABASE_URL="postgres://nem:nem@localhost:5433/nem?sslmode=disable" \
  RISK_MODE=shadow CLIENT_IP_HEADER=X-Client-Ip ./bin/api.exe
```

`RISK_MODE=shadow` stops the fraud engine holding first payments from brand-new customers. `CLIENT_IP_HEADER=X-Client-Ip` lets the test give each virtual customer its own address, so the per-address demo sign-up limit does not apply to a test that makes sixty customers from one machine. Per-customer limits (300 a minute, 30 signed money requests a minute) stay on.

## Load test (k6)

```sh
docker run --rm -e BASE_URL=http://host.docker.internal:8080 -e USERS=60 -e RATE=25 -e DURATION=60s \
  -v "$PWD/loadtest:/scripts" grafana/k6:latest run /scripts/transfers.js
```

k6 signs every request with Ed25519 through its built-in WebCrypto, exactly as the app does. Each customer is made with `POST /v1/auth/demo` (slow: about 3 seconds each, six months of history), then the test sends signed, idempotent ₦1 transfers between them at a constant arrival rate. One in twenty is replayed with the same key to prove nothing is paid twice. Thresholds: p95 under 500 ms, p99 under 1.5 s, no failed request.

Result on a laptop (API, Postgres in Docker, k6 in Docker), 60 customers, 25 transfers a second for 60 seconds:

| Metric | Result |
|---|---|
| Transfers completed | 1,501, none failed |
| Latency p95 / p99 / max | 167 ms / 183 ms / 232 ms |
| Replays returning the same transfer | 76 of 76 |

25 a second is about 2,000,000 transfers a day, and it is the ceiling this test can reach without breaking the per-customer limit of 30 signed requests a minute across 60 customers, not the server's ceiling.

After any run, check the ledger:

```sh
docker exec -i nem-bank-postgres-1 psql -U nem -d nem -v ON_ERROR_STOP=1 < loadtest/verify.sql
```

Every query must return zero rows: entries net to zero per currency, cached balances equal their postings, no customer deposit below zero, no money created or destroyed, no transfer stuck. After the run above all were clean (17,709 entries).

## Crash-recovery test

```sh
node loadtest/crash-recovery.mjs
```

Starts the API, makes 24 customers, sends 24 external transfers (the saga: hold, send to the sandbox bank, wait for its answer, settle or auto-reverse), and kills the process with `SIGKILL` while they are in flight. It then restarts the API and waits. It passes when every transfer reaches a final state, no hold stays active, and `verify.sql` is clean.

Result: 23 transfers were accepted and all 23 were in flight at the kill. After the restart 22 completed and 1 was reversed (a simulated bank failure, which the sandbox draws 2% of the time); no hold was left active and every ledger invariant held. Recovery needs no special code: jobs and the transactional outbox live in Postgres, and the partner dedupes by reference, so the restarted process simply picks the work up.
