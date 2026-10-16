import {
  COLORS,
  DURATION,
  EASING,
  ELEVATION,
  RADIUS,
  SPACING,
  SPRING,
  TYPE_SCALE,
  type ColorScheme,
  type ColorTokens,
} from '@nem/shared';
import * as SystemUI from 'expo-system-ui';
import { createContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';

export type ThemePreference = 'system' | ColorScheme;

export interface Theme {
  readonly scheme: ColorScheme;
  readonly colors: ColorTokens;
  readonly type: typeof TYPE_SCALE;
  readonly spacing: typeof SPACING;
  readonly radius: typeof RADIUS;
  readonly elevation: typeof ELEVATION;
  readonly motion: { duration: typeof DURATION; easing: typeof EASING; spring: typeof SPRING };
  readonly preference: ThemePreference;
  readonly setPreference: (preference: ThemePreference) => void;
}

/** Dark is the brand default, so an unknown system scheme falls back to it. */
export function resolveScheme(
  preference: ThemePreference,
  system: string | null | undefined,
): ColorScheme {
  if (preference !== 'system') return preference;
  return system === 'light' ? 'light' : 'dark';
}

export const ThemeContext = createContext<Theme | null>(null);

export type Props = {
  children: ReactNode;
  /** The persisted preference arrives from the preferences store (T3.10). */
  initialPreference?: ThemePreference;
  /** Off for nested providers (e.g. a light panel in the gallery) so only the root sets the window colour. */
  syncSystemUI?: boolean;
};

export function ThemeProvider({
  children,
  initialPreference = 'system',
  syncSystemUI = true,
}: Props) {
  const system = useColorScheme();
  const [preference, setPreference] = useState<ThemePreference>(initialPreference);
  const scheme = resolveScheme(preference, system);

  const theme = useMemo<Theme>(
    () => ({
      scheme,
      colors: COLORS[scheme],
      type: TYPE_SCALE,
      spacing: SPACING,
      radius: RADIUS,
      elevation: ELEVATION,
      motion: { duration: DURATION, easing: EASING, spring: SPRING },
      preference,
      setPreference,
    }),
    [scheme, preference],
  );

  // The root view shows behind screen transitions and the keyboard; match it to
  // the theme so a theme switch never flashes white.
  useEffect(() => {
    if (syncSystemUI) void SystemUI.setBackgroundColorAsync(theme.colors.background);
  }, [syncSystemUI, theme.colors.background]);

  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}
