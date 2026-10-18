import { Stack } from 'expo-router';

import { useTheme } from '@/theme';

/** Currency conversion (M8): a multi-step flow presented as one modal stack. */
export default function ConvertFlowLayout() {
  const { colors } = useTheme();
  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
    />
  );
}
