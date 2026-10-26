import { Stack } from 'expo-router';

import { NewDeviceNotice } from '@/features/auth/components/NewDeviceNotice';
import { RouteErrorBoundary } from '@/features/shell/RouteErrorBoundary';
import { useTheme } from '@/theme';

// A crash in any signed-in screen shows the crash screen inside the app shell.
export { RouteErrorBoundary as ErrorBoundary };

// A deep link straight into a modal (a pay link, an invite) still gets the tabs
// underneath it, so closing the modal lands on the app instead of nothing.
export const unstable_settings = { initialRouteName: '(tabs)' };

/**
 * Signed-in app: the five tabs, with flows (send, convert, KYC) and tools
 * presented as modals over them (architecture §3).
 */
export default function AppLayout() {
  const { colors } = useTheme();
  return (
    <>
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="transactions/index" />
        <Stack.Screen name="transactions/[id]" />
        <Stack.Screen name="statements/index" />
        <Stack.Screen name="statements/[id]" />
        <Stack.Screen name="disputes/new" options={{ presentation: 'modal' }} />
        <Stack.Screen name="send" options={{ presentation: 'modal' }} />
        <Stack.Screen name="convert" options={{ presentation: 'modal' }} />
        <Stack.Screen name="bills" options={{ presentation: 'modal' }} />
        <Stack.Screen name="goals" options={{ presentation: 'modal' }} />
        <Stack.Screen name="round-ups" options={{ presentation: 'modal' }} />
        <Stack.Screen name="locks" options={{ presentation: 'modal' }} />
        <Stack.Screen name="kyc" options={{ presentation: 'modal' }} />
        <Stack.Screen name="new-card" options={{ presentation: 'modal' }} />
        <Stack.Screen name="physical-card" options={{ presentation: 'modal' }} />
        <Stack.Screen name="demo-controls" options={{ presentation: 'modal' }} />
        <Stack.Screen name="ajo" options={{ presentation: 'modal' }} />
        <Stack.Screen name="qr" options={{ presentation: 'modal' }} />
        <Stack.Screen name="assistant" options={{ presentation: 'modal' }} />
      </Stack>
      <NewDeviceNotice />
    </>
  );
}
