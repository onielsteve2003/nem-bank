import { Stack } from 'expo-router';

import { ModalSheetHost } from '@/components';
import { useTheme } from '@/theme';

// Opening a goal straight from the Grow tab still puts the list under it, so Back works.
export const unstable_settings = { initialRouteName: 'index' };

/** Savings goals (SAV-2): the list, a new goal and each goal, as one modal stack. */
export default function GoalsFlowLayout() {
  const { colors } = useTheme();
  return (
    <ModalSheetHost>
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
      />
    </ModalSheetHost>
  );
}
