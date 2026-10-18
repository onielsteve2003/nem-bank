import { Stack } from 'expo-router';

import { useTheme } from '@/theme';

/**
 * Signed-in app: the five tabs, with flows (send, convert, KYC) and tools
 * presented as modals over them (architecture §3).
 */
export default function AppLayout() {
  const { colors } = useTheme();
  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
    >
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="send" options={{ presentation: 'modal' }} />
      <Stack.Screen name="convert" options={{ presentation: 'modal' }} />
      <Stack.Screen name="kyc" options={{ presentation: 'modal' }} />
      <Stack.Screen name="demo-controls" options={{ presentation: 'modal' }} />
    </Stack>
  );
}
