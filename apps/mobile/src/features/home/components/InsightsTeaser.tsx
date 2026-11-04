import type { Schema } from '@nem/contracts';
import { formatMoney, isZero } from '@nem/shared';
import { ChartPie, ChevronRight } from '@/components/icons';
import { StyleSheet, View } from 'react-native';

import { Card, Icon, MoneyText, Text } from '@/components';
import { monthLabel } from '@/features/insights/insights';
import { CATEGORIES } from '@/features/transactions/categories';
import { fromApiMoney } from '@/lib/money';
import { useTheme } from '@/theme';
import { useTranslation } from 'react-i18next';

/**
 * This month's spending so far and where most of it went. The full breakdown
 * lives in Insights; this is the doorway. Last month is shown as a
 * reference, not as "x% less": a month in progress against a whole month
 * would always look like saving.
 */
export function InsightsTeaser({
  spending,
  hidden,
  onOpen,
}: {
  spending: Schema<'SpendingBreakdown'>;
  hidden: boolean;
  onOpen: () => void;
}) {
  const { colors, spacing, radius } = useTheme();
  const { t } = useTranslation();
  const total = fromApiMoney(spending.total);
  const top = spending.categories[0];
  const topMeta = top ? (CATEGORIES[top.category] ?? CATEGORIES.other) : null;
  const month = monthLabel(spending.month);
  const previous = fromApiMoney(spending.previous_total);
  const where =
    isZero(total) || !top || !topMeta
      ? t('home.insights.nothingSpent')
      : t('home.insights.mostWent', {
          category: topMeta.label.toLowerCase(),
          pct: top.share_pct,
        });
  const summary = [
    t('home.insights.spentSoFarAmount', {
      month,
      amount: hidden ? t('common.hidden') : formatMoney(total),
    }),
    where,
    !isZero(previous) && !hidden
      ? t('home.insights.lastMonthAmount', { amount: formatMoney(previous) })
      : null,
  ]
    .filter(Boolean)
    .join('. ');

  return (
    <Card
      variant="outline"
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={summary}
      accessibilityHint={t('home.insights.hint')}
      style={{ marginHorizontal: spacing[4] }}
    >
      <View style={[styles.row, { gap: spacing[3] }]}>
        <View style={[styles.icon, { backgroundColor: colors.raised, borderRadius: radius.md }]}>
          <Icon icon={ChartPie} size="md" color="primaryText" />
        </View>
        <View style={[styles.flex, { gap: spacing[1] }]}>
          <Text variant="label" color="textMuted">
            {t('home.insights.spentSoFar', { month })}
          </Text>
          <MoneyText value={total} variant="amount" masked={hidden} />
          <Text variant="caption" color="textMuted">
            {where}
          </Text>
          {!isZero(previous) && (
            <View style={[styles.row, { gap: spacing[1] }]}>
              <Text variant="caption" color="textMuted">
                {t('home.insights.lastMonth')}
              </Text>
              <MoneyText value={previous} variant="caption" color="textMuted" masked={hidden} />
            </View>
          )}
        </View>
        <Icon icon={ChevronRight} size="sm" color="textMuted" />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  icon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
});
