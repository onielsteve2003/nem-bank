import type { ReactNode } from 'react';
import { View } from 'react-native';

import { Text } from '@/components';
import { useTheme } from '@/theme';

export function KitSection({ title, children }: { title: string; children: ReactNode }) {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing[3] }}>
      <Text variant="h3">{title}</Text>
      {children}
    </View>
  );
}
