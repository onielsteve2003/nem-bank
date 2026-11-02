import { Stack } from 'expo-router';

import { FullScreenModalProvider, ModalSheetHost } from '@/components';
import { useTheme } from '@/theme';

export const unstable_settings = { initialRouteName: 'index' };

/** Notifications (M17): the inbox and its settings, as one modal stack. */
export default function NotificationsFlowLayout() {
  const { colors } = useTheme();
  return (
    <FullScreenModalProvider>
      <ModalSheetHost>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.background },
          }}
        />
      </ModalSheetHost>
    </FullScreenModalProvider>
  );
}
