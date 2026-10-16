import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { FONTS, ThemeProvider, useTheme } from '@/theme';

// Keep the splash up until the fonts are ready, so text never renders in the
// system font and then jumps.
void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useFonts(FONTS);
  // A font that fails to load falls back to the system font rather than
  // leaving the user stuck on the splash screen.
  const ready = loaded || error !== null;

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  return (
    <ThemeProvider>
      <ThemedStack />
    </ThemeProvider>
  );
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
