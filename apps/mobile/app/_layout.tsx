import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { ScreenBannerProvider, ToastProvider } from '@/components';
import { RepositoryProvider, useSimulation } from '@/data';
import { AppLock } from '@/features/lock/AppLock';
import { AppErrorBoundary } from '@/features/shell/CrashScreen';
import { CoolOffBanner } from '@/features/auth/components/CoolOffBanner';
import { OfflineBanner } from '@/features/shell/OfflineBanner';
import { PhoneFrame } from '@/features/shell/PhoneFrame';
import { RootNavigator } from '@/features/shell/RootNavigator';
import { useSessionWatcher } from '@/features/shell/useSessionWatcher';
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
        <QueryProvider>
          <StoredThemeProvider>
            <PhoneFrame>
              <BottomSheetModalProvider>
                <ToastProvider>
                  <SessionWatcher />
                  <ScreenBannerProvider value={offlineBanner}>
                    <AppErrorBoundary>
                      <RootNavigator />
                    </AppErrorBoundary>
                    <AppLock />
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

/** Applies the saved Demo Controls network settings to the mock bank. */
function DemoSimulationSync() {
  const simulation = useSimulation();
  useEffect(() => (simulation ? bindSimulation(simulation) : undefined), [simulation]);
  return null;
}

const styles = StyleSheet.create({ root: { flex: 1 } });
