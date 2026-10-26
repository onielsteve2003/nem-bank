import { Stack } from 'expo-router';

import { ModalSheetHost } from '@/components';
import { useTheme } from '@/theme';

// Offers and loans (CRD-2, CRD-3) open on top of the hub, so Back works.
export const unstable_settings = { initialRouteName: 'index' };

/** Credit (CRD-1..4): the hub, offers and loans, as one modal stack. */
export default function CreditFlowLayout() {
  const { colors } = useTheme();
  return (
    <ModalSheetHost>
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
      />
    </ModalSheetHost>
  );
}
