// First, so the startup clock starts before the rest of the app loads.
import '@/lib/startup';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ReducedMotionConfig, ReduceMotion } from 'react-native-reanimated';

import { ScreenBannerProvider, ToastProvider } from '@/components';
import { RepositoryProvider, useSimulation } from '@/data';
import { AppLock } from '@/features/lock/AppLock';
import { AppErrorBoundary } from '@/features/shell/CrashScreen';
import { CoolOffBanner } from '@/features/auth/components/CoolOffBanner';
import { BankWakingOverlay } from '@/features/shell/BankWakingOverlay';
import { OfflineBanner } from '@/features/shell/OfflineBanner';
import { PhoneFrame } from '@/features/shell/PhoneFrame';
import { RootNavigator } from '@/features/shell/RootNavigator';
import { useBankWarmup } from '@/features/shell/useBankWarmup';
import { useSessionWatcher } from '@/features/shell/useSessionWatcher';
import i18n from '@/lib/i18n';
import { QueryProvider } from '@/lib/query';
import { bindSimulation, usePreferencesStore, useStoresHydrated } from '@/stores';
import { FONTS, ThemeProvider } from '@/theme';

// Keep the splash up until the fonts are ready, so text never renders in the
// system font and then jumps, and until the stores (the session above all) are
// read, so the auth gate never flashes the wrong side.
void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useFonts(FONTS);
  const hydrated = useStoresHydrated();
  // A font that fails to load falls back to the system font rather than
  // leaving the user stuck on the splash screen.
  const ready = (loaded || error !== null) && hydrated;

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  // Sheets and toasts sit inside the theme so they render in the active scheme, and
  // inside the web demo's phone frame so they stay on the phone's screen.
  return (
    <GestureHandlerRootView style={styles.root}>
      <RepositoryProvider>
        <DemoSimulationSync />
        <LanguageSync />
        <MotionSync />
        <QueryProvider>
          <StoredThemeProvider>
            <PhoneFrame>
              <BottomSheetModalProvider>
                <ToastProvider>
                  <SessionWatcher />
                  <BankWarmup />
                  <ScreenBannerProvider value={offlineBanner}>
                    <AppErrorBoundary>
                      <RootNavigator />
                    </AppErrorBoundary>
                    <AppLock />
                    <BankWakingOverlay />
                  </ScreenBannerProvider>
                </ToastProvider>
              </BottomSheetModalProvider>
            </PhoneFrame>
          </StoredThemeProvider>
        </QueryProvider>
      </RepositoryProvider>
    </GestureHandlerRootView>
  );
}

const offlineBanner = (
  <>
    <OfflineBanner />
    <CoolOffBanner />
  </>
);

/** Session expiry, and the cache wipe on sign-out (T4.6). */
function SessionWatcher() {
  useSessionWatcher();
  return null;
}

/** Wakes the free-tier API on launch and keeps it warm (T31.4). */
function BankWarmup() {
  useBankWarmup();
  return null;
}

/** The theme follows the persisted appearance setting (SET-1). */
function StoredThemeProvider({ children }: { children: ReactNode }) {
  const appearance = usePreferencesStore((s) => s.appearance);
  const setAppearance = usePreferencesStore((s) => s.setAppearance);
  return (
    <ThemeProvider preference={appearance} onPreferenceChange={setAppearance}>
      {children}
    </ThemeProvider>
  );
}

/** Shows the app in the saved language (SET-2); strings re-render when it changes. */
function LanguageSync() {
  const language = usePreferencesStore((s) => s.language);
  useEffect(() => {
    if (i18n.language !== language) void i18n.changeLanguage(language);
  }, [language]);
  return null;
}

/**
 * Settings → Reduce motion → Always reduce (SET-4) for every Reanimated
 * animation, entering and exiting ones included; `system` follows the phone.
 */
function MotionSync() {
  const always = usePreferencesStore((s) => s.reduceMotion === 'always');
  return <ReducedMotionConfig mode={always ? ReduceMotion.Always : ReduceMotion.System} />;
}

/** Applies the saved Demo Controls network settings to the mock bank. */
function DemoSimulationSync() {
  const simulation = useSimulation();
  useEffect(() => (simulation ? bindSimulation(simulation) : undefined), [simulation]);
  return null;
}

const styles = StyleSheet.create({ root: { flex: 1 } });
