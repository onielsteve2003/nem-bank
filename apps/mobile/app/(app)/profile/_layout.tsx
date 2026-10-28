import { Stack } from 'expo-router';

import { ModalSheetHost } from '@/components';
import { useTheme } from '@/theme';

export const unstable_settings = { initialRouteName: 'index' };

/** Your profile (M15): details, photo and @nemtag, as one modal stack. */
export default function ProfileFlowLayout() {
  const { colors } = useTheme();
  return (
    <ModalSheetHost>
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
      />
    </ModalSheetHost>
  );
}
