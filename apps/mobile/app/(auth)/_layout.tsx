import { Stack } from 'expo-router';

import { useTheme } from '@/theme';

/** Signed-out screens: welcome, sign-up and login (M5). */
export default function AuthLayout() {
  const { colors } = useTheme();
  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
    />
  );
}
