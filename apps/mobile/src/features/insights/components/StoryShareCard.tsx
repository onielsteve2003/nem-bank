import { Sparkles } from 'lucide-react-native';
import type { ComponentRef, Ref } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  return (
    <View
      ref={ref}
      collapsable={false}
      accessible
      accessibilityLabel={t('insights.story.shareCardLabel', {
        month: summary.month,
        lines: summary.lines.join('. '),
      })}
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
          {t('insights.story.brand')}
        </Text>
      </View>
      <Text variant="h2">{t('insights.story.my', { month: summary.month })}</Text>
      {summary.lines.map((line) => (
        <Text key={line} variant="bodyStrong">
          {line}
        </Text>
      ))}
      <Text variant="caption" color="textMuted">
        {t('insights.story.noAmounts')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
});
