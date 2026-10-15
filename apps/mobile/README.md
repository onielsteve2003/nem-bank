# Nem Bank — mobile app

The customer app, built with Expo (SDK 57) and Expo Router. It runs in **Expo Go** on iOS and Android, and on the web.

## Run it

```bash
pnpm install          # from the repo root
pnpm dev              # same as: pnpm --filter mobile start
```

Scan the QR code with the iPhone camera (or the Expo Go app on Android). Press `w` in the terminal to open the web build.

## Layout

| Path | Purpose |
|---|---|
| `app/` | Expo Router routes. Route files stay thin and render a screen from `src/features`. |
| `src/features/<domain>/` | Feature code: screens, components, hooks, utils, tests. |

Only modules bundled in Expo Go are allowed, so the app never needs a custom native build.
