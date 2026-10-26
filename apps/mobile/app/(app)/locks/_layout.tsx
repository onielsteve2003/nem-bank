import { Stack } from 'expo-router';

import { ModalSheetHost } from '@/components';
import { useTheme } from '@/theme';

// Opening a lock from a notification still puts the list under it, so Back works.
export const unstable_settings = { initialRouteName: 'index' };

/** Locked savings (SAV-4): the list, a new lock and each lock, as one modal stack. */
export default function LocksFlowLayout() {
  const { colors } = useTheme();
  return (
    <ModalSheetHost>
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
      />
    </ModalSheetHost>
  );
}
