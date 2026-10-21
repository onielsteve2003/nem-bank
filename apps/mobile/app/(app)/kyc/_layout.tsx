import { Stack } from 'expo-router';

import { ModalSheetHost } from '@/components';
import { useTheme } from '@/theme';

/** Identity verification (M15): a multi-step flow presented as one modal stack. */
export default function KycFlowLayout() {
  const { colors } = useTheme();
  // Sheets (PIN, pickers) must render inside the native modal, not behind it.
  return (
    <ModalSheetHost>
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
      />
    </ModalSheetHost>
  );
}
