# @nem/contracts

The Nem Bank HTTP API contract. `openapi.yaml` (OpenAPI 3.1) is the single source of truth: the mobile app and console use the TypeScript types generated from it, and the Go API (Phase 2) generates its Gin server interfaces from the same file.

## What is in the contract

| Area                                                                                                                                                                                                                                                      | Paths                                                                     | Auth                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------- |
| Customer app: auth, accounts, transactions, statements, transfers, beneficiaries, requests, payment links, QR, FX, cards, bills, savings, ajo, credit, insights, security, KYC, disputes, support, notifications, family, assistant, preferences, privacy | `/v1/...`                                                                 | `bearerAuth` (customer JWT)  |
| Realtime                                                                                                                                                                                                                                                  | `POST /v1/realtime/tickets`, then a WebSocket; events are `RealtimeEvent` | `bearerAuth`                 |
| Demo Controls                                                                                                                                                                                                                                             | `/v1/demo/...` (demo personas only)                                       | `bearerAuth`                 |
| Staff console                                                                                                                                                                                                                                             | `/v1/admin/...`                                                           | `staffAuth` (TOTP-gated)     |
| Developer platform                                                                                                                                                                                                                                        | `/v1/developer/...`, plus `webhooks` for outbound events                  | `bearerAuth` or `apiKeyAuth` |
| Partner callbacks                                                                                                                                                                                                                                         | `/v1/partner-webhooks/{partner}`                                          | HMAC signature               |
| Public pages                                                                                                                                                                                                                                              | `/v1/public/...`, `/v1/help/...`                                          | none                         |

Conventions (money as minor-unit strings, problem+json errors, cursor pages, `Idempotency-Key` and device-signature headers on money-moving requests, step-up tokens) are described at the top of `openapi.yaml`. Vendor extensions: `x-roles` (staff roles allowed), `x-maker-checker` (needs a second approver), `x-api-key-scope` (scope an API key needs).

## Commands

```sh
pnpm --filter @nem/contracts generate          # regenerate src/schema.gen.ts after editing openapi.yaml
pnpm --filter @nem/contracts lint              # Redocly lint + ESLint
pnpm --filter @nem/contracts check:generated   # fails if the generated types are stale (runs in CI)
```

## Using the types

```ts
import type { Schema, Transfer, RealtimeEventOf } from '@nem/contracts';

type Quote = Schema<'TransferQuote'>;
type BalanceEvent = RealtimeEventOf<'account.balance_updated'>;
```

Never hand-write a type that duplicates the contract; add it to `openapi.yaml` and regenerate.
