import { Stack } from 'expo-router';

import { ModalSheetHost } from '@/components';
import { useTheme } from '@/theme';

/** Send money (M7): a multi-step flow presented as one modal stack. */
export default function SendFlowLayout() {
  const { colors } = useTheme();
  return (
    <ModalSheetHost>
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
      />
    </ModalSheetHost>
  );
}
