import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { useParkWebEntryLink } from '@/features/shell/linking';
import { useSessionStore } from '@/stores';
import { useTheme } from '@/theme';

/**
 * The route gate (T4.2). Signed-in routes and signed-out routes are each behind a
 * guard, so a deep link into the wrong group lands on the right screen instead,
 * and signing in or out moves the user without any screen navigating by hand.
 * The splash stays up until the session has been read from SecureStore (root
 * layout), so the first frame is already on the correct side of the gate.
 */
export function RootNavigator() {
  const { colors, scheme } = useTheme();
  const signedIn = useSessionStore((s) => s.status === 'signedIn');
  const needsNemtag = useSessionStore((s) => s.session?.needsNemtag === true);
  useParkWebEntryLink(signedIn);

  return (
    <>
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
      >
        <Stack.Screen name="index" />
        <Stack.Protected guard={signedIn && !needsNemtag}>
          <Stack.Screen name="(app)" />
        </Stack.Protected>
        {/* The last onboarding step (AUTH-10): signed in, but no @nemtag yet. */}
        <Stack.Protected guard={signedIn && needsNemtag}>
          <Stack.Screen name="choose-nemtag" />
        </Stack.Protected>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="(auth)" />
        </Stack.Protected>
        {/* The design system gallery is a dev tool, open on both sides of the gate. */}
        <Stack.Screen name="kit" />
      </Stack>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
    </>
  );
}
