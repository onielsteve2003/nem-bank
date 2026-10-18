import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Card, SectionHeader, Text } from '@/components';
import { useTheme } from '@/theme';

export type Props = { title: string; description: string; children: ReactNode };

/** One group of controls: a heading, what it is for, and a card. */
export function DemoSection({ title, description, children }: Props) {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing[2] }}>
      <SectionHeader title={title} />
      <Text variant="bodySmall" color="textMuted">
        {description}
      </Text>
      <Card>
        <View style={{ gap: spacing[4] }}>{children}</View>
      </Card>
    </View>
  );
}

/** A labelled row of chips; each chip announces its own selected state. */
export function ChipRow({ label, children }: { label: string; children: ReactNode }) {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing[2] }}>
      <Text variant="label" color="textMuted">
        {label}
      </Text>
      <View style={[styles.chips, { gap: spacing[2] }]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
});
