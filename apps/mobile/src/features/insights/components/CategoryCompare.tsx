import type { Schema } from '@nem/contracts';
import { formatMoney, money } from '@nem/shared';
import { Minus, Sparkles, TrendingDown, TrendingUp, type LucideIcon } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Card, Icon, MoneyText, Text } from '@/components';
import { CATEGORIES } from '@/features/transactions/categories';
import { fromApiMoney } from '@/lib/money';
import { useTheme } from '@/theme';

import { changeOf, monthLabel, shiftMonth, type Change } from '../insights';

type CategorySpend = Schema<'CategorySpend'>;

const CHANGE: Record<
  Change['kind'],
  { icon: LucideIcon; color: 'danger' | 'success' | 'textMuted' }
> = {
  more: { icon: TrendingUp, color: 'danger' },
  less: { icon: TrendingDown, color: 'success' },
  same: { icon: Minus, color: 'textMuted' },
  new: { icon: Sparkles, color: 'textMuted' },
};

/** The change in words; money is formatted exactly, never from a float. */
function changeText(change: Change, before: CategorySpend['previous_amount'], prev: string) {
  switch (change.kind) {
    case 'new':
      return `Nothing here in ${prev}`;
    case 'same':
      return `${prev}: ${formatMoney(fromApiMoney(before))}`;
    default:
      return `${formatMoney(money(change.minor, before.currency))} ${change.kind} than ${prev}`;
  }
}

export type Props = {
  categories: readonly CategorySpend[];
  month: string;
  inProgress: boolean;
  hidden: boolean;
};

/** Every category this month, each set against the month before (INS-1). */
export function CategoryCompare({ categories, month, inProgress, hidden }: Props) {
  const { colors, radius, spacing } = useTheme();
  const prev = monthLabel(shiftMonth(month, -1));
  return (
    <Card padded={false}>
      <View accessibilityRole="list">
        {categories.map((c) => {
          const meta = CATEGORIES[c.category] ?? CATEGORIES.other;
          const now = fromApiMoney(c.amount);
          const change = changeOf(
            BigInt(c.amount.amount_minor),
            BigInt(c.previous_amount.amount_minor),
            inProgress,
          );
          const look = CHANGE[change.kind];
          const text = hidden
            ? `Compared with ${prev}`
            : changeText(change, c.previous_amount, prev);
          return (
            <View
              key={c.category}
              style={[styles.row, { gap: spacing[3], padding: spacing[4] }]}
              accessible
              accessibilityLabel={`${meta.label}: ${hidden ? 'hidden' : formatMoney(now)}, ${c.share_pct}% of spending. ${text}.`}
            >
              <View
                style={[styles.icon, { backgroundColor: colors.raised, borderRadius: radius.md }]}
              >
                <Icon icon={meta.icon} size="md" color="primaryText" />
              </View>
              <View style={[styles.flex, { gap: spacing[1] }]}>
                <View style={[styles.row, { gap: spacing[2] }]}>
                  <Text variant="bodyStrong" style={styles.flex} numberOfLines={1}>
                    {meta.label}
                  </Text>
                  <MoneyText value={now} variant="bodyStrong" masked={hidden} />
                </View>
                <View style={[styles.row, { gap: spacing[1] }]}>
                  <Icon icon={look.icon} size="sm" color={look.color} />
                  <Text variant="caption" color="textMuted" style={styles.flex}>
                    {text}
                  </Text>
                  <Text variant="caption" color="textMuted" tabular>
                    {c.share_pct}%
                  </Text>
                </View>
              </View>
            </View>
          );
        })}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  icon: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
});
