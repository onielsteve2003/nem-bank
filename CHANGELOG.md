# Changelog

All notable changes to Nem Bank. Nem Bank is a portfolio project: no real money moves.

## [1.0.0] - 2026-11-16

First release: the customer app, the staff console, the developer platform and the Go API behind them, running live.

### Customer app (iPhone and Android through Expo Go, and the web)

- Multi-currency wallets (naira, dollar, pound, euro) with account details, statements and receipts.
- Transfers to Nem users by @nemtag and to other banks (sandbox rail), with the fee shown before you pay, name check, cooling-off for new payees, scheduled payments, payment links, QR codes and bill splitting.
- FX with a locked quote and the exact amount received; simulated inbound foreign money.
- Virtual cards with freeze, online and international controls, and a Reveal screen behind step-up.
- Savings goals with round-ups and interest, locked savings, digital Ajo groups, and a credit offer with a repayment schedule.
- Bills and airtime, saved billers and scheduled bills.
- Spending insights, budgets and a cash-flow forecast with subscription detection.
- Security centre: device list and bound keys, new-device cool-off, duress PIN, panic mode, scam checker, security checkup and alerts.
- KYC tiers 1 to 3, family accounts with parental controls and approvals, disputes, support chat, notifications.
- Nem Assistant: answers questions and prepares transfers and card freezes; only your PIN or biometrics confirm. Every AI feature has a non-AI fallback, a settings toggle and a "why".
- English and Nigerian Pidgin, light and dark themes, low-data and reduce-motion modes, screen-reader labels.
- Try the demo: one tap into a seeded persona with Demo Controls (fund, KYC tier, fail the next transfer, time travel).

### Go API

- Double-entry ledger in integer minor units, with balancing enforced by the database and append-only postings.
- Contract-first: 278 operations from one OpenAPI file, used to generate both clients and the server.
- Transfer saga with idempotency keys, device-bound Ed25519 request signing, step-up, and a risk engine (LightGBM scored in pure Go, with a rules fallback) that holds risky payments for review.
- Transactional outbox and River jobs for notifications, signed webhooks, realtime events and scheduled work.
- Domains: identity, accounts, transfers, FX, cards, bills, savings, Ajo, credit, KYC, notifications, support, family, privacy exports and erasure, admin and developer platforms.
- Four models trained in Python and scored in Go: fraud, transaction categories, scam messages and credit.

### Staff console and developer platform

- KYC review, fraud cases, disputes, support inbox, ledger and trial balance, feature flags, config with maker-checker approvals, and a hash-chained audit log.
- Developer portal with API keys (shown once, stored hashed), signed webhooks with retries, and an interactive API reference.
- A public demo console on a mock bank, and a private live console for real staff.

### Operations

- API on Render, PostgreSQL on Neon (same region), web and consoles on Vercel, redeployed on every push.
- Nightly encrypted `pg_dump` backup through GitHub Actions.
- UptimeRobot checks every 5 minutes (also keeps the free host awake); Grafana Cloud metrics, an importable dashboard and a 5xx alert. See [docs/monitoring](docs/monitoring/README.md).
- CI: lint, typecheck, tests, CodeQL and gitleaks. A k6 load test and a crash-recovery test live in `apps/api/loadtest`.

### Security

- OWASP API Top 10 and MASVS review and a STRIDE threat model ([docs/security](docs/security/security-review.md)). Nothing critical or high; fixed a missing request body ceiling and missing defensive response headers.
- Rate limits per address and per customer; confirmed against the live API that a caller cannot choose their own bucket with spoofed headers.

### Fixed during launch

- Add money opened a blank screen on the live web app (a sheet rendered outside the toast provider).
- Try the demo failed with `409 device_key_in_use` after signing up for a real account, because a browser holds one device key. The app now uses a fresh key and retries once, for both the demo and login.
- Sign-up could not pass the choose-a-tag step on the real API; 26 operations that only the mock bank had were built.

### Known limits

- The free API host sleeps when idle, so the first request can be slow.
- Money, the interbank rail, BVN/NIN checks and billers are simulated behind interfaces. SMS OTP, USSD, physical cards and international transfers need paid partners and show a Paid Feature Notice.
- `POST /v1/demo/reset` answers 501 on purpose: the ledger is append-only, so the app starts a fresh demo customer.
- The rate limiter is in memory (resets on restart, not shared across instances).
- The models are trained on synthetic data, so their metrics prove the pipeline, not real-world accuracy.
- The security review was a code review and pattern scan, not a penetration test.
- Backups are written but a restore has not been tested. Trace delivery to Grafana is not confirmed.
