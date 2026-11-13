# Security review (T32.1)

Reviewed 2026-11-13 against the OWASP API Security Top 10 (2023) and the OWASP MASVS v2 areas. Method: read the router, validator, config, limiter, token and signature code; pattern scans over the whole API for the usual mistakes (string-built SQL, `math/rand`, `exec`, `InsecureSkipVerify`, non-constant-time secret compares, secrets in log calls, unbounded `ReadAll`, id-only lookups in customer queries); read the mobile storage and session code. This is a code review, not a penetration test. See [threat-model.md](threat-model.md) for the STRIDE analysis.

## Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | Medium | **No request body ceiling** on ordinary JSON routes. Only signed, keyed and partner routes were bounded (64 KB); a caller could stream a large body at sign-up or login and make the server buffer it (API4). | Fixed: `BodyLimit` middleware, 1 MiB JSON and 8 MiB multipart, refused with 413 before validation. Tested. |
| 2 | Low | **No defensive response headers.** JSON responses could be cached by a browser or intermediary and carried no `nosniff`, framing or HSTS policy (API8). | Fixed: `SecurityHeaders` middleware on every response (`no-store`, `nosniff`, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `no-referrer`, HSTS). Handlers that need other values (docs page, file downloads) set their own. Tested. |
| 3 | Low | **Offline query cache is plaintext** in app storage (balances, transactions, profile). Needed for offline reads (MASVS-STORAGE). | Accepted. Cleared on sign-out and on session expiry; excludes auth, card reveal, quotes and privacy exports. Encrypting the cache is a possible follow-up. |
| 4 | Low | **Public demo endpoints** create customers for anyone (API6). | Accepted for the demo: 30 per hour per address, no password anyone can know, purged after 24 hours. A production deployment would remove them. |
| 5 | Info | Rate limiter is in memory, per process. | Accepted: one instance. Needs a shared store if scaled out. |
| 6 | Info | Fraud model scores a first payment from a customer with no history as risky (carried in from T31.5). | Open, a model-tuning item rather than a vulnerability. |

Nothing critical or high was found.

## OWASP API Security Top 10 (2023)

| Risk | Assessment |
|---|---|
| **API1 Broken object level authorization** | Customer-facing queries are scoped by the caller's ID in SQL. A scan of every `:one` query that looks a row up by `id` alone found only `GetTransferByID`, used by staff views and system jobs (release, scheduled runs), never by a customer route. The domain test suites cover the main resources; this was a pattern scan, not an exhaustive proof. |
| **API2 Broken authentication** | EdDSA tokens, algorithm pinned, 10 minute life, session checked per call; rotating refresh with reuse detection; argon2id for passwords and PIN; lockout with backoff; OTP stored as an HMAC with attempt limits; login and OTP routes rate limited before hashing; staff need TOTP; separate signing keys per realm. Good. |
| **API3 Broken object property level authorization** | The contract rejects unknown fields (`unknown_field`) and handlers map named fields, so there is no mass assignment. Responses are typed structs from the contract. Staff views mask email and phone. Good. |
| **API4 Unrestricted resource consumption** | Per-address and per-customer limits, tighter on expensive and sensitive routes, pagination caps, server timeouts, small pool. Body ceiling added (finding 1). Uploads capped at 5 MB by their services. |
| **API5 Broken function level authorization** | Realm per security scheme, `x-roles` for staff, `x-api-key-scope` for keys with deny by default when a scope is missing, maker-checker on sensitive staff actions. Good. |
| **API6 Unrestricted access to sensitive business flows** | Signed and rate-limited money routes, 30 a minute per customer; idempotency; cooling-off for new beneficiaries; limits and fraud engine; one open dispute per transaction; demo creation limited (finding 4). |
| **API7 Server side request forgery** | The only user-influenced outbound call is webhook delivery: HTTPS only, credentials and literal internal hosts refused, dialer refuses private ranges after DNS resolution, no redirects, 10 second timeout. Model and email providers use fixed hosts. Good. |
| **API8 Security misconfiguration** | Production refuses to start without real keys, a metrics token, an HTTPS-only CORS list and a real mailer; wildcards refused; separate staff key enforced; panic output never reaches the client; `/metrics` is token gated with a constant-time compare. Headers added (finding 2). |
| **API9 Improper inventory management** | One contract, one version (`/v1`), served spec at `/openapi.json`; routes outside the contract are listed in the router (probes, metrics, socket, signed file and export links). No debug or test routes found. |
| **API10 Unsafe consumption of APIs** | Provider answers are untrusted: model output is parsed and validated field by field, sanitised before display and never executes anything; partner callbacks are HMAC verified and deduped; FX rate jumps over 25% are rejected. Good. |

## Injection and crypto scans

- SQL: sqlc everywhere. The only string-built SQL is in the test database helper, quoting identifiers it generates itself.
- `math/rand` appears only in the demo history generator (deterministic seeding on purpose). Security randomness uses `crypto/rand`.
- No `exec`, no templates rendering user input, no `InsecureSkipVerify`.
- Secret comparisons use `hmac.Equal` or `subtle.ConstantTimeCompare` throughout.
- No log call carries a password, PIN, code, token, BVN, NIN, PAN or CVV.

## MASVS v2 (mobile)

| Area | Assessment |
|---|---|
| **STORAGE** | Tokens and the device private key in SecureStore (Keychain / Keystore). Offline query cache is plaintext (finding 3). Preferences are non-sensitive. No tokens in AsyncStorage. |
| **CRYPTO** | Ed25519 via `@noble/ed25519`; key created on the device, never leaves it; signs a canonical payload with nonce and timestamp. No custom crypto. |
| **AUTH** | PIN, biometrics and step-up for sensitive actions; app lock after 60 seconds in the background; duress PIN and panic mode. |
| **NETWORK** | HTTPS only in production (the config refuses HTTP origins). No certificate pinning: Expo Go cannot do it, and it is a stated limitation. |
| **PLATFORM** | Deep links are parsed and validated before use; screen-capture block and app-switcher overlay on sensitive screens where supported; no exported native components of our own. |
| **CODE** | No `console` logging in production paths (the two calls are dev-only or fail-safe); dependencies audited in CI; gitleaks in CI. |
| **RESILIENCE** | Not in scope for a demo: no jailbreak or root detection, no obfuscation. Stated, not hidden. |
| **PRIVACY** | PII never goes to a model; export and deletion flows implemented (NDPA); analytics and ad SDKs: none. |

## What would come next in a real programme

Independent penetration test, certificate pinning in a development build, encrypted offline cache, a shared rate limit store, secrets from a managed vault with rotation, external append-only audit storage, and dependency and container scanning on every release.
