# Nem Console

The staff back office (and, later, the developer portal) for Nem Bank. Vite + React +
TypeScript, with TanStack Router for routing and TanStack Query for server state.

## Run it

```sh
pnpm install          # from the repo root
pnpm console          # http://localhost:5173
```

## How it is put together

- **Design tokens** come from `@nem/shared`, the same Volt Noir palette and scales the
  mobile app uses. `src/theme/cssVars.ts` turns them into CSS custom properties, so the
  stylesheet never holds a colour of its own. Dark is the default; the OS preference or
  the theme picker switches to light.
- **Data** follows the mobile app's layering: page → feature hook → TanStack Query →
  repository → mock (now) or http (Phase 2). Repository method types are generated from
  `packages/contracts/openapi.yaml`, so the mock cannot drift from the API.
- **Mock back office** (`src/data/mock`) answers staff operations in memory with a little
  simulated latency. Operations the demo does not cover yet return a `501 not_implemented`
  problem, which pages show as an error state.

## Check it

```sh
pnpm --filter console typecheck
pnpm --filter console lint
pnpm --filter console test
pnpm --filter console build
```
