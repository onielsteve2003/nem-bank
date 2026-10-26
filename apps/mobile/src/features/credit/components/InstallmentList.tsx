import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { StyleSheet, View } from 'react-native';

import { Text, type TextColor } from '@/components';
import { formatGoalDate } from '@/features/savings/goals';
import { fromApiMoney } from '@/lib/money';
import { useTheme } from '@/theme';

type Installment = Schema<'Installment'>;

const STATUS: Record<Installment['status'], { label: string; color: TextColor }> = {
  upcoming: { label: 'Upcoming', color: 'textMuted' },
  due: { label: 'Due today', color: 'warning' },
  paid: { label: 'Paid', color: 'success' },
  overdue: { label: 'Overdue', color: 'danger' },
};

type Props = {
  installments: readonly Installment[];
  /** Offers have nothing paid yet, so the status column is left out. */
  showStatus?: boolean;
};

/** Repayment schedule: one row per instalment with its date, amount and state. */
export function InstallmentList({ installments, showStatus = false }: Props) {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing[3] }} accessibilityRole="list">
      {installments.map((i) => {
        const amount = formatMoney(fromApiMoney(i.amount));
        const status = STATUS[i.status];
        const paid = fromApiMoney(i.paid);
        const part = i.status !== 'paid' && paid.amount > 0n ? ` · ${formatMoney(paid)} paid` : '';
        return (
          <View
            key={i.number}
            style={[styles.row, { gap: spacing[3] }]}
            accessible
            accessibilityLabel={`Payment ${i.number}, ${formatGoalDate(i.due_date)}, ${amount}${
              showStatus ? `, ${status.label}${part}` : ''
            }`}
          >
            <View style={styles.flex}>
              <Text variant="bodyStrong">{formatGoalDate(i.due_date)}</Text>
              {showStatus && (
                <Text variant="caption" color={status.color}>
                  {status.label}
                  {part}
                </Text>
              )}
            </View>
            <Text variant="bodyStrong">{amount}</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
