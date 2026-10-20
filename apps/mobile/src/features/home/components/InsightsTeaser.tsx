import type { Schema } from '@nem/contracts';
import { formatMoney, isZero } from '@nem/shared';
import { ChartPie, ChevronRight } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Card, Icon, MoneyText, Text } from '@/components';
import { CATEGORIES } from '@/features/transactions/categories';
import { fromApiMoney } from '@/lib/money';
import { useTheme } from '@/theme';

const monthName = new Intl.DateTimeFormat('en-NG', { month: 'long', timeZone: 'UTC' });

/** "2026-10" → "October". */
export function monthLabel(month: string): string {
  return monthName.format(new Date(`${month}-01T00:00:00Z`));
}

/**
 * This month's spending so far and where most of it went. The full breakdown
 * lives in Insights (Grow); this is the doorway. Last month is shown as a
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
  const total = fromApiMoney(spending.total);
  const top = spending.categories[0];
  const topMeta = top ? (CATEGORIES[top.category] ?? CATEGORIES.other) : null;
  const month = monthLabel(spending.month);
  const previous = fromApiMoney(spending.previous_total);
  const where =
    isZero(total) || !top || !topMeta
      ? 'Nothing spent yet this month.'
      : `Most went on ${topMeta.label.toLowerCase()} (${top.share_pct}%).`;
  const summary = [
    `Spent in ${month} so far: ${hidden ? 'hidden' : formatMoney(total)}`,
    where,
    !isZero(previous) && !hidden ? `Last month: ${formatMoney(previous)}` : null,
  ]
    .filter(Boolean)
    .join('. ');

  return (
    <Card
      variant="outline"
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={summary}
      accessibilityHint="Opens Insights"
      style={{ marginHorizontal: spacing[4] }}
    >
      <View style={[styles.row, { gap: spacing[3] }]}>
        <View style={[styles.icon, { backgroundColor: colors.raised, borderRadius: radius.md }]}>
          <Icon icon={ChartPie} size="md" color="primaryText" />
        </View>
        <View style={[styles.flex, { gap: spacing[1] }]}>
          <Text variant="label" color="textMuted">
            Spent in {month} so far
          </Text>
          <MoneyText value={total} variant="amount" masked={hidden} />
          <Text variant="caption" color="textMuted">
            {where}
          </Text>
          {!isZero(previous) && (
            <View style={[styles.row, { gap: spacing[1] }]}>
              <Text variant="caption" color="textMuted">
                Last month:
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
