import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { StyleSheet, View } from 'react-native';

import { Text } from '@/components';
import { fromApiMoney } from '@/lib/money';
import { useTheme } from '@/theme';

import { paidCount, paidFraction } from '../splits';

/** How much of a split bill is paid: a bar, the amounts and how many friends have paid. */
export function SplitProgress({ split }: { split: Schema<'SplitBill'> }) {
  const { colors, radius, spacing } = useTheme();
  const fraction = paidFraction(split);
  const { paid, of } = paidCount(split);
  const paidText = formatMoney(fromApiMoney(split.paid_total));
  const totalText = formatMoney(fromApiMoney(split.total));
  return (
    <View style={{ gap: spacing[1] }}>
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={`${paidText} of ${totalText} paid`}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }}
        style={[styles.track, { backgroundColor: colors.border, borderRadius: radius.pill }]}
      >
        <View
          style={[
            styles.fill,
            {
              width: `${fraction * 100}%`,
              backgroundColor: fraction >= 1 ? colors.success : colors.primary,
              borderRadius: radius.pill,
            },
          ]}
        />
      </View>
      <View style={styles.between}>
        <Text variant="caption" color="textMuted">
          {paidText} of {totalText}
        </Text>
        <Text variant="caption" color="textMuted">
          {paid} of {of} paid
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: { height: 8, overflow: 'hidden' },
  fill: { height: '100%' },
  between: { flexDirection: 'row', justifyContent: 'space-between' },
});
