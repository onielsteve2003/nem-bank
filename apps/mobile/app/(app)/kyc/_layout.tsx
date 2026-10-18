import { Stack } from 'expo-router';

import { useTheme } from '@/theme';

/** Identity verification (M15): a multi-step flow presented as one modal stack. */
export default function KycFlowLayout() {
  const { colors } = useTheme();
  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
    />
  );
}
