import { Stack } from 'expo-router';

import { ModalSheetHost } from '@/components';
import { useTheme } from '@/theme';

export const unstable_settings = { initialRouteName: 'index' };

/** AI and your data (AI-8): the overview and one model card per feature. */
export default function AiFlowLayout() {
  const { colors } = useTheme();
  return (
    <ModalSheetHost>
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
      />
    </ModalSheetHost>
  );
}
