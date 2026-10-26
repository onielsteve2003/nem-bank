import { Stack } from 'expo-router';

import { ModalSheetHost } from '@/components';
import { useTheme } from '@/theme';

// Opening a group or an invite from a link still puts the list under it, so Back works.
export const unstable_settings = { initialRouteName: 'index' };

/** Ajo (AJO-1, AJO-2): the groups, a new group, each group and invites, as one modal stack. */
export default function AjoFlowLayout() {
  const { colors } = useTheme();
  return (
    <ModalSheetHost>
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
      />
    </ModalSheetHost>
  );
}
