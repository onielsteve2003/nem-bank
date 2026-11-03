# Nem Bank

[![CI](https://github.com/onielsteve2003/nem-bank/actions/workflows/ci.yml/badge.svg)](https://github.com/onielsteve2003/nem-bank/actions/workflows/ci.yml) [![CodeQL](https://github.com/onielsteve2003/nem-bank/actions/workflows/codeql.yml/badge.svg)](https://github.com/onielsteve2003/nem-bank/actions/workflows/codeql.yml)

A mobile-first digital bank for Nigerians, with multi-currency wallets, scam and fraud protection, digital ajo and an AI assistant. It's built with React Native (Expo), Go and PostgreSQL.

> 🚧 In development. This is a portfolio project that runs on simulated money; it is not a licensed bank.

## Live demo

| Where                      | Link                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web demo (Vercel)          | https://nem-bank-fodx.vercel.app                                                                                                                     |
| iPhone / Android (Expo Go) | [EAS Update `preview` channel](https://expo.dev/accounts/onielsteve/projects/nem-bank): install Expo Go, open the latest update and scan its QR code |
| Staff console (Vercel)     | https://nem-console.vercel.app: pick a demo staff account on the login page (password `nem-console-demo`, code from the on-page authenticator)       |
| Developer portal           | https://nem-console.vercel.app/developers · [API reference](https://nem-console.vercel.app/api-reference.html)                                       |

The web demo and the console redeploy on every push to `main` (the console only when it or a shared package changed).

## Repository layout

A [pnpm workspaces](https://pnpm.io/workspaces) monorepo:

| Path                 | What it is                                                                        |
| -------------------- | --------------------------------------------------------------------------------- |
| `apps/mobile`        | The customer app: Expo + React Native, running in Expo Go, Android and on the web |
| `apps/console`       | Staff back-office and developer portal (Vite + React)                             |
| `apps/api`           | Go API with a double-entry ledger and PostgreSQL                                  |
| `packages/shared`    | `@nem/shared`: the money type, currencies, validation schemas and design tokens   |
| `packages/contracts` | `@nem/contracts`: the OpenAPI contract and the TypeScript types generated from it |

## Getting started

Requirements: Node 22 LTS (see `.nvmrc`) and pnpm 11 (`corepack enable`).

```bash
pnpm install
pnpm dev         # start the mobile app (Expo)
pnpm check       # lint, typecheck and test every workspace
```

## API contract

`packages/contracts/openapi.yaml` (OpenAPI 3.1) is the single source of truth for the API. After editing it:

```bash
pnpm --filter @nem/contracts lint       # Redocly lint
pnpm --filter @nem/contracts generate   # regenerate src/schema.gen.ts
```

Import API types from `@nem/contracts`; never hand-write them.
