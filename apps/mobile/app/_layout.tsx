import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { ToastProvider } from '@/components';
import { RepositoryProvider, useSimulation } from '@/data';
import { QueryProvider } from '@/lib/query';
import { bindSimulation, usePreferencesStore, useStoresHydrated } from '@/stores';
import { FONTS, ThemeProvider, useTheme } from '@/theme';

// Keep the splash up until the fonts are ready, so text never renders in the
// system font and then jumps.
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

  // Sheets and toasts sit inside the theme so they render in the active scheme.
  return (
    <GestureHandlerRootView style={styles.root}>
      <RepositoryProvider>
        <DemoSimulationSync />
        <QueryProvider>
          <StoredThemeProvider>
            <BottomSheetModalProvider>
              <ToastProvider>
                <ThemedStack />
              </ToastProvider>
            </BottomSheetModalProvider>
          </StoredThemeProvider>
        </QueryProvider>
      </RepositoryProvider>
    </GestureHandlerRootView>
  );
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

function ThemedStack() {
  const { colors, scheme } = useTheme();

  return (
    <>
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
      />
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
    </>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
