import type { Schema } from '@nem/contracts';
import { formatMoney, money } from '@nem/shared';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { Icon, MoneyText, PressableScale, Text } from '@/components';
import { MASK } from '@/components/MoneyText';
import { CATEGORIES } from '@/features/transactions/categories';
import { fromApiMoney } from '@/lib/money';
import { useTheme } from '@/theme';

import { BUDGET_STATUS, usedPct } from '../budgets';

export type Props = {
  budget: Schema<'Budget'>;
  hidden: boolean;
  onPress?: () => void;
};

/** One budget: how much of it is used, in a bar, words and an icon (INS-2). */
export function BudgetRow({ budget, hidden, onPress }: Props) {
  const { colors, radius, spacing } = useTheme();
  const { t } = useTranslation();
  const meta = CATEGORIES[budget.category] ?? CATEGORIES.other;
  const status = BUDGET_STATUS[budget.status];
  const spent = fromApiMoney(budget.spent);
  const limit = fromApiMoney(budget.limit);
  const pct = usedPct(budget);
  const gap = limit.amount - spent.amount;
  const left = money(gap < 0n ? -gap : gap, limit.currency);
  const remaining = hidden
    ? t('insights.budgetRow.used', { pct })
    : t(gap < 0n ? 'insights.budgetRow.over' : 'insights.budgetRow.left', {
        amount: formatMoney(left),
      });
  const label = t('insights.budgetRow.label', {
    category: meta.label,
    status: status.label,
    detail: hidden
      ? remaining
      : t('insights.budgetRow.spentOf', {
          spent: formatMoney(spent),
          limit: formatMoney(limit),
          remaining,
        }),
  });

  return (
    <PressableScale
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={label}
      accessibilityHint={onPress ? t('insights.budgetRow.hint') : undefined}
      style={{ padding: spacing[4], gap: spacing[2] }}
    >
      <View style={[styles.row, { gap: spacing[3] }]}>
        <Icon icon={meta.icon} size="md" color="primaryText" />
        <Text variant="bodyStrong" style={styles.flex} numberOfLines={1}>
          {meta.label}
        </Text>
        <Icon icon={status.icon} size="sm" color={status.color} />
        <Text variant="caption" color={status.color}>
          {status.label}
        </Text>
      </View>
      <View
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: Math.min(pct, 100) }}
        style={[styles.track, { backgroundColor: colors.border, borderRadius: radius.pill }]}
      >
        <View
          style={[
            styles.fill,
            {
              width: `${Math.min(pct, 100)}%`,
              backgroundColor: colors[status.color],
              borderRadius: radius.pill,
            },
          ]}
        />
      </View>
      <View style={[styles.row, { gap: spacing[1] }]}>
        <MoneyText value={spent} variant="caption" color="textMuted" masked={hidden} />
        <Text variant="caption" color="textMuted" style={styles.flex}>
          {t('insights.budgetRow.of', {
            amount: hidden ? `₦${MASK}` : formatMoney(limit, { trimZeroMinor: true }),
          })}
        </Text>
        <Text variant="caption" color={gap < 0n ? 'danger' : 'textMuted'}>
          {remaining}
        </Text>
      </View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  track: { height: 8, overflow: 'hidden' },
  fill: { height: '100%' },
});
