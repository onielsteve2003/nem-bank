import type { ConfigContext, ExpoConfig } from 'expo/config';

// EAS project @onielsteve/nem-bank. The ID is public (it ships in every bundle).
const EAS_PROJECT_ID = 'b6e844bf-850e-4c7e-9992-6b81e2f0bfe9';

// Typed Expo config. EXPO_PUBLIC_* variables are not read here: Metro inlines them
// into the bundle, and src/lib/env.ts validates them at startup.
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Nem Bank',
  slug: 'nem-bank',
  owner: 'onielsteve',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  scheme: 'nembank',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: 'com.nembank.app',
    supportsTablet: false,
  },
  android: {
    package: 'com.nembank.app',
    adaptiveIcon: {
      backgroundColor: '#0B0D12',
      foregroundImage: './assets/images/android-icon-foreground.png',
      backgroundImage: './assets/images/android-icon-background.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
  },
  web: {
    output: 'static',
    favicon: './assets/images/favicon.png',
  },
  plugins: [
    'expo-router',
    [
      'expo-splash-screen',
      {
        backgroundColor: '#0B0D12',
        image: './assets/images/splash-icon.png',
        imageWidth: 76,
      },
    ],
    // Expo Go ships its own copy; this is for standalone builds.
    [
      'expo-local-authentication',
      { faceIDPermission: 'Nem Bank uses Face ID to unlock the app and approve payments.' },
    ],
  ],
  // The SDK runtime policy is the one Expo Go can load EAS updates for.
  runtimeVersion: { policy: 'sdkVersion' },
  updates: {
    url: `https://u.expo.dev/${EAS_PROJECT_ID}`,
  },
  extra: {
    ...config.extra,
    eas: { projectId: EAS_PROJECT_ID },
  },
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
});
