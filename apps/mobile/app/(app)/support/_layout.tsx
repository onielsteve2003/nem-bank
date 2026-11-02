import { Stack } from 'expo-router';

import { FullScreenModalProvider, ModalSheetHost } from '@/components';
import { useTheme } from '@/theme';

export const unstable_settings = { initialRouteName: 'index' };

/** Help and support (M17): your chats, a new chat and one chat, as one modal stack. */
export default function SupportFlowLayout() {
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
