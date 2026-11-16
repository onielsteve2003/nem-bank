# Architecture decision records

Twelve decisions that shaped the build. Each says what was decided, why, and what it costs.

## ADR-1: React Native with Expo, Expo Go only

**Context.** The owner builds on Windows with no Mac and no paid Apple account, and wants to test on a real iPhone.
**Decision.** React Native with Expo, using only modules that ship in Expo Go.
**Consequences.** The app runs on an iPhone, on Android and on the web from one codebase. No custom native modules, so no native passkeys or push-token tricks; the design works around that (ADR-9).

## ADR-2: Go, Gin and PostgreSQL

**Context.** A bank backend is concurrent and correctness-critical.
**Decision.** Go for the API, PostgreSQL for all state.
**Consequences.** Strong typing and cheap concurrency; a single database gives real transactions across the ledger, the transfer and the outbox.

## ADR-3: Contract-first OpenAPI with generated code on both sides

**Context.** A mobile app, a console and an API must agree on hundreds of operations.
**Decision.** `packages/contracts/openapi.yaml` is the source of truth. TypeScript types and Go server stubs are generated from it.
**Consequences.** No hand-written request types and no drift. Changing a field is a contract change first, which is slower for small edits and safer for every other edit.

## ADR-4: Double-entry ledger, integer minor units, balance enforced by the database

**Context.** Money bugs are the most expensive bugs.
**Decision.** Every movement is a balanced journal entry. Amounts are `bigint` minor units. Postings are append-only; corrections are new entries. The database rejects an unbalanced entry.
**Consequences.** Balances can always be rebuilt and audited. Reversals and refunds are explicit entries. Rewinding history is impossible, which is why the demo's "reset" starts a fresh customer instead.

## ADR-5: Modular monolith with River jobs and a transactional outbox

**Context.** Free hosting gives one service. Workflows still have to survive crashes.
**Decision.** One Go service with domain packages. Background work runs on River (Postgres-backed). Events are written to an outbox in the same transaction as the change.
**Consequences.** No message broker to host. Delivery is at least once, so every subscriber is idempotent. The crash-recovery test is the proof.

## ADR-6: sqlc, not an ORM

**Context.** Money paths need SQL that a reviewer can read.
**Decision.** Hand-written queries compiled to typed Go by sqlc.
**Consequences.** Explicit locking and joins, no hidden queries. Some query shapes trip sqlc's parser and need rewriting.

## ADR-7: Simulated money, sandbox partners behind interfaces, Paid Feature Notice

**Context.** A real bank needs a licence and paid partners. The project must cost $0 and be honest about it.
**Decision.** All money is simulated. Each partner (bank rail, KYC, biller, card processor, LLM, mailer) sits behind an interface with a free sandbox implementation. Features that need a paid partner open a Paid Feature Notice.
**Consequences.** Going live means writing adapters, not rewriting features. Every demo screen carries a notice that it is not a real bank.

## ADR-8: ML trained in Python, scored in pure Go

**Context.** Fraud, categorisation, scam and credit models are wanted, but a Python service cannot be hosted for free.
**Decision.** Train in `ml/` (Python), export the model files, score in Go. Python and Go are checked against golden test cases at 1e-5 or better.
**Consequences.** A fraud score takes under a microsecond and has a rules fallback. The training data is synthetic, so the metrics prove the pipeline, not real-world accuracy; each model card says so.

## ADR-9: Device-bound Ed25519 request signing

**Context.** A PIN alone is weak, and Expo Go has no native passkeys.
**Decision.** Each device makes an Ed25519 key. Money-moving requests carry a signature over the method, path, time, nonce and body hash.
**Consequences.** A stolen token cannot move money. A browser or phone holds one key, so the same key cannot be on two accounts; the app mints a fresh key when the bank says it is taken (demo versus real account).

## ADR-10: Money actions are never queued offline

**Context.** An offline queue can send a payment twice or at a surprising time.
**Decision.** Reads work from cache offline. Anything that moves money needs a live connection.
**Consequences.** Offline users see their data but cannot pay. No duplicate or surprise debits.

## ADR-11: No open-source licence on the public repository

**Context.** The code is public for review, and the owner may commercialise it.
**Decision.** No licence file. The code is visible, not licensed for reuse.
**Consequences.** Recruiters can read it; nobody else may legally reuse it.

## ADR-12: pnpm workspaces monorepo

**Context.** The mobile app and the console share the money type, design tokens and API types.
**Decision.** One repository with pnpm workspaces: `apps/*` and `packages/*`.
**Consequences.** One CI, one version of shared code. Tooling must be run from the right package (formatting from `apps/mobile`, for example).
