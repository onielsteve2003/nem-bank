# Case study: building Nem Bank

Nem Bank is a mobile-first digital bank for Nigerians: naira, dollar, pound and euro wallets, transfers with the fee shown first, scam and fraud protection, digital ajo (rotating savings), and an AI assistant that can prepare a payment but never send one. It is a portfolio project. No real money moves, and every screen says so.

**Try it:** https://nem-bank-fodx.vercel.app (tap _Try the demo_, PIN `2580`). Staff console (demo data): https://nem-bank-nine.vercel.app.

## The goal

Build something that looks and behaves like a real bank, end to end, for $0: customer app, staff back office, developer platform and the API behind them. The bar was senior-level engineering, so the interesting work is where banks are hard: money correctness, security, failure handling and honesty about what is simulated.

## What was built

| Part               | What it is                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Customer app       | Expo / React Native for iPhone, Android and the web. English and Nigerian Pidgin, light and dark, screen-reader labels throughout |
| API                | Go modular monolith on PostgreSQL: 278 contract operations, 47 migrations, about 30 domain packages                               |
| Staff console      | KYC review, fraud cases, disputes, support chat, ledger, feature flags, maker-checker approvals, hash-chained audit log           |
| Developer platform | API keys, signed webhooks with retries, interactive API reference                                                                 |
| ML                 | Fraud, categorisation, scam and credit models trained in Python, scored in pure Go                                                |

## Decisions that mattered

The full list is in [adr/](adr/README.md). Four shaped everything else:

1. **A real double-entry ledger.** Integer minor units, balanced entries enforced by the database, append-only postings. It made reversals, refunds, holds and statements simple, because they are all just entries.
2. **Contract first.** One OpenAPI file generates the types for the app, the console and the Go server. The mobile app was built first against an on-device mock bank that implements the same contract, so the backend arrived as a config change (`API_MODE=http`), not a rewrite.
3. **Transactional outbox plus River jobs.** Free hosting gives one service and no broker. Events written in the same transaction as the change give crash-safe notifications, webhooks and realtime updates.
4. **Device-bound signing.** Money requests are signed with a key that never leaves the device, which a stolen token cannot do.

## Measured results

- **Load test (k6, local API + Postgres):** 60 customers, signed idempotent transfers at 25/s for 60 s. 1,501 completed, 0 failed, p95 167 ms, p99 183 ms. 76 of 76 replayed requests returned the original transfer. The ledger verification query was clean after 17,709 entries.
- **Crash recovery:** the API was killed (SIGKILL) with 23 transfers in flight. After restart all reached a final state (22 completed, 1 reversed), no holds were left active, and ledger invariants held.
- **Risk model:** on a synthetic test set of 78,000 rows (406 fraud), PR-AUC 0.94 against 0.33 for the rules baseline. The hold threshold catches 85% of fraud at 88% precision. The data is synthetic, so this proves the pipeline, not real-world accuracy; the model card says so.
- **Security review:** OWASP API Top 10, MASVS and a STRIDE threat model. Nothing critical or high. Fixed during the review: no request body ceiling and missing defensive response headers.

## Problems found and fixed along the way

These are the useful part of the story.

- **A cross-region database made the demo seed take 138 s.** The demo seed makes about 1,000 sequential round trips. Neon had been created in Ohio while the API ran in Frankfurt, and the request timed out with a 502. Recreating the database in the API's region fixed it.
- **Sign-up stuck at the tag step on the real API.** The mock bank had `checkNemtag` and `setNemtag`; the Go API did not. The deploy showed 26 of 273 operations answering 501. All were built, except demo reset, which stays 501 on purpose: the ledger is append-only, so the app starts a fresh demo customer instead of rewinding.
- **A fraud model that was too good.** The first fraud model scored 0.98 because the synthetic attacks were obvious. They were made subtler and the rules baseline was strengthened, and both changes are recorded in the model card.
- **The Add money blank screen.** After going live, Add money showed a blank page. A headless browser reproduced it: a sheet rendered in a portal outside the toast provider, so `useToast` threw. Moving the provider fixed it.
- **One device key, two accounts.** A browser holds one key. After signing up and logging out, Try the demo was refused with 409 because the key belonged to the real account. The app now mints a fresh key and retries once, in both directions.

## What is simulated, and what would change to go live

Money, the interbank rail, BVN/NIN checks, FX inbound and billers are simulated behind interfaces (`BankPartner`, `KycProvider`, `Biller`, `CardProcessor`, `LlmProvider`, `Mailer`). Going live would need a licensed banking-as-a-service partner and real adapters for those interfaces. SMS OTP, USSD, physical cards and international transfers need paid partners and open a Paid Feature Notice instead of failing.

## Known limits

- The free API host sleeps; the first request can take a while (the app shows "Waking up the bank").
- The risk limiter is in memory, so it resets on restart and does not span several instances.
- The security review was a code review and pattern scan, not a penetration test.
- The ML models are trained on synthetic data.
- No monitoring or alerting is wired up yet (planned: uptime checks and dashboards).

## Stack

React Native, Expo, TypeScript, TanStack Query, Zustand · Go, Gin, oapi-codegen, sqlc, River, PostgreSQL · Python, scikit-learn, LightGBM · Vite, React · OpenAPI 3.1 · GitHub Actions, CodeQL, gitleaks · Render, Neon, Vercel, EAS.
