// https://docs.expo.dev/guides/monorepos/
// Expo's default config detects the pnpm workspace: it watches the monorepo root and
// resolves from both node_modules folders, so `@nem/*` packages compile from source.
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
