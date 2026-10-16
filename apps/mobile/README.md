# Nem Bank — mobile app

The customer app, built with Expo (SDK 57) and Expo Router. It runs in **Expo Go** on iOS and Android, and on the web.

## Run it

```bash
pnpm install          # from the repo root
pnpm dev              # same as: pnpm --filter mobile start
```

Scan the QR code with the iPhone camera (or the Expo Go app on Android). Press `w` in the terminal to open the web build.

## Open without the dev server (EAS Update)

The app is published to the EAS project [`@onielsteve/nem-bank`](https://expo.dev/accounts/onielsteve/projects/nem-bank) on the `preview` channel:

```bash
pnpm --filter mobile update:preview --message "what changed"
```

Open the update page on expo.dev and scan its QR code with the iPhone camera to load it in Expo Go. The runtime version follows the Expo SDK (`exposdk:57.0.0`), so Expo Go can open it.

## Web demo

```bash
pnpm build:web       # from the repo root: static export to apps/mobile/dist
npx serve apps/mobile/dist
```

Vercel builds the same export on every push to `main` (config in the root `vercel.json`).

## Layout

| Path                     | Purpose                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `app/`                   | Expo Router routes. Route files stay thin and render a screen from `src/features`. |
| `src/features/<domain>/` | Feature code: screens, components, hooks, utils, tests.                            |

Only modules bundled in Expo Go are allowed, so the app never needs a custom native build.
