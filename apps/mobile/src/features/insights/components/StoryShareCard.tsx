import { Sparkles } from 'lucide-react-native';
import type { ComponentRef, Ref } from 'react';
import { StyleSheet, View } from 'react-native';

import { Icon, Text } from '@/components';
import { useTheme } from '@/theme';

import type { ShareSummary } from '../story';

export type Props = {
  summary: ShareSummary;
  ref?: Ref<ComponentRef<typeof View>>;
};

/**
 * The image that leaves the phone when a story is shared: the month and its
 * shape, never an amount or a balance (INS-5).
 */
export function StoryShareCard({ summary, ref }: Props) {
  const { colors, radius, spacing } = useTheme();
  return (
    <View
      ref={ref}
      collapsable={false}
      accessible
      accessibilityLabel={`Share card. My ${summary.month} with Nem. ${summary.lines.join('. ')}.`}
      style={{
        backgroundColor: colors.surface,
        borderColor: colors.primary,
        borderWidth: 2,
        borderRadius: radius.lg,
        padding: spacing[5],
        gap: spacing[3],
      }}
    >
      <View style={[styles.row, { gap: spacing[2] }]}>
        <Icon icon={Sparkles} color="primaryText" />
        <Text variant="label" color="primaryText">
          NEM MONEY STORY
        </Text>
      </View>
      <Text variant="h2">My {summary.month}</Text>
      {summary.lines.map((line) => (
        <Text key={line} variant="bodyStrong">
          {line}
        </Text>
      ))}
      <Text variant="caption" color="textMuted">
        No amounts shared · nem-bank demo
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
});
