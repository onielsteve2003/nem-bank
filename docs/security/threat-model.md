# Nem Bank: STRIDE threat model

Scope: the Go API (`apps/api`), the Expo app (`apps/mobile`) and the staff and developer console (`apps/console`). Nem Bank is a **demo bank on simulated money**: no real funds, no real BVN/NIN, no licensed rails. The model treats it as if it were real, because the controls are the point.

## Assets

| Asset | Why it matters |
|---|---|
| Ledger (journal entries, postings) | Money truth. Append-only; every entry sums to zero per currency. |
| Customer credentials (password, PIN, device key) | Authorise money movement. |
| Session and refresh tokens | Act as the customer. |
| PII (name, phone, email, BVN/NIN, ID photos) | NDPA scope. Encrypted per field where sensitive. |
| Card PAN and CVV | Encrypted PAN; CVV derived, never stored. |
| Staff access (TOTP, roles) | Can freeze, refund, change config. |
| Signing and encryption keys | Compromise breaks everything above. |

## Trust boundaries

1. **Phone / browser to API** (internet, untrusted client).
2. **Console to API** (staff realm, separate signing key and TOTP).
3. **Developer API key holder to API** (third party, scoped keys).
4. **API to partners** (sandbox bank, Brevo, Gemini/Groq, Expo push): outbound, and inbound signed callbacks.
5. **API to Postgres** (trusted, one pool).

## Data flow summary

App signs money requests with a device key (Ed25519: canonical payload, nonce, timestamp) and sends an `Idempotency-Key`. The API validates each request against the OpenAPI contract, authenticates the realm, rate limits, verifies the signature, then runs the handler in one database transaction that posts to the ledger and writes an outbox event. River jobs and subscribers handle everything asynchronous.

## STRIDE

### Spoofing

| Threat | Control | Residual |
|---|---|---|
| Stolen password used from another phone | New devices need an email OTP and get a cool-off; money requests need the device signature, so a password alone cannot move money. | A phished OTP plus password gives login, not payment. |
| Forged or replayed access token | EdDSA JWT, algorithm pinned to EdDSA, 10 minute life, session row checked on every call (revocation is immediate). | None known. |
| Refresh token theft | Rotation with reuse detection: a replay ends the whole token family. | Attacker who uses the token first wins the race once; the victim is then signed out and notified. |
| Customer token used on the staff realm | Separate signing key and verifier per realm (config refuses equal keys). | None. |
| Forged partner callback | HMAC over the raw bytes, constant-time compare, event ID dedupe. | Shared secret rotation is manual. |
| Cloned or stolen API key | Stored as SHA-256 only, shown once, scoped, revocable, cannot mint keys. | A leaked live key works until revoked. |

### Tampering

| Threat | Control | Residual |
|---|---|---|
| Altering an amount or recipient in flight | TLS plus the device signature over method, target and body. | None beyond TLS. |
| Double submit / retry changing meaning | Idempotency key bound to a request hash: same key with a different body is a 409. | None. |
| Editing ledger history | Append-only tables, deferred balance trigger, hash-chained audit log with a verify endpoint. | A DBA with superuser rights can still rewrite rows; the chain makes it detectable, not impossible. |
| Tampered statement or export | Statement carries a content hash and QR verify; export links are signed and single use. | None. |
| Oversized or malformed bodies | Contract validation, `unknown_field` rejected, 1 MiB JSON / 8 MiB upload ceiling (added in T32.1). | None. |

### Repudiation

| Threat | Control | Residual |
|---|---|---|
| Customer denies a transfer | Device-signed request, idempotency record, append-only transfer timeline. | None. |
| Staff denies an action | Every staff action audited by name and ID; maker-checker for money-affecting changes; opening a KYC photo is itself audited. | Audit rows share the database. Ship them to external storage in production. |

### Information disclosure

| Threat | Control | Residual |
|---|---|---|
| Account-number or name harvesting | Name enquiry (`POST /v1/payees/resolve`) is limited to 60 an hour per customer and the term is never logged. | Slow harvesting stays possible within limits, because naming the payee is the feature. |
| BVN/NIN/ID leak from the database | AES-256-GCM with key versions and per-row binding; blind index for lookups. | Keys live in env vars. A host compromise exposes them. |
| Secrets in logs | Access log records the route template, never raw path or query; no secret fields are logged; the log mailer is refused in production. | Free-text fields users type are never logged, but a new log line could regress this. Reviewed by grep in CI is future work. |
| Browser caching of API responses | `Cache-Control: no-store` and `nosniff` on every response (added in T32.1). | None. |
| Cross-origin reads | Exact-origin CORS allow list, no credentials, wildcards refused. | None. |
| On-device data | Tokens and the device key in SecureStore; screen-capture block and app-switcher overlay on sensitive screens. | The offline query cache (balances, transactions) is plaintext in app storage; cleared on sign-out. See the review's MASVS notes. |
| LLM data leakage | PII redacted before any model call; tools return aggregates only. | A first name typed by the customer is not detectable. |

### Denial of service

| Threat | Control | Residual |
|---|---|---|
| Request floods | Per-address and per-customer GCRA limits, tighter limits on login, OTP, resend, demo and name enquiry; server read/write/idle timeouts. | In-memory limiter is per process: fine for one instance, needs a shared store for several. |
| Expensive hashing used as a lever | The route limits sit before argon2id work. | None. |
| Webhook delivery abused for SSRF | HTTPS only, dialer refuses loopback, private, link-local, CGNAT and multicast after DNS, no redirects, 10 s timeout. | None. |
| Database exhaustion | Small pool, request timeouts, pagination caps. | Free-tier Postgres is easy to saturate. Load tested in T32.2. |
| Free host cold start | Keep-warm ping and the app's "Waking up the bank" flow. | By design. |

### Elevation of privilege

| Threat | Control | Residual |
|---|---|---|
| Customer reads another customer's rows (BOLA) | Every customer query is scoped by the caller's ID in SQL; staff-only loaders are separate service methods reachable only from staff routes. | Reviewed by pattern scan and per-domain tests, not proven exhaustively. |
| Customer calls a staff endpoint | Staff routes use `staffAuth` plus `x-roles`; customer tokens fail verification in that realm. | None. |
| Staff acts beyond their role | RBAC from the contract's `x-roles`, maker-checker above thresholds, staff accounts created only by an operator CLI. | A compromised admin account is powerful by design. |
| API key reaches routes outside its scope | Scope checked from `x-api-key-scope`; a route with no scope gives keys no access. | None. |
| Assistant tricked into moving money | Tools only prepare an action; execution needs PIN plus device signature in the app. | None by construction. |
| Mass assignment | Strict contract: unknown fields rejected; handlers map explicit fields. | None. |

## Top residual risks (ordered)

1. **Keys in environment variables.** A host compromise reads every secret. Production should use the host's secret store and rotate on any suspicion.
2. **Public demo endpoints.** `POST /v1/auth/demo` creates real rows for anyone, limited to 30 per hour per address and purged after 24 hours. Acceptable for a demo. A real deployment would remove it.
3. **Plaintext offline cache on the phone.** Cleared at sign-out; protected by the OS sandbox only.
4. **In-process rate limiter.** Correct for one instance only.
5. **Audit log in the same database as the ledger.** Tamper-evident, not tamper-proof.
