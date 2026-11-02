import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { Text, type TextColor } from '@/components';
import { formatGoalDate } from '@/features/savings/goals';
import { withLabel } from '@/lib/i18n';
import { fromApiMoney } from '@/lib/money';
import { useTheme } from '@/theme';

type Installment = Schema<'Installment'>;

const STATUS: Record<Installment['status'], { label: string; color: TextColor }> = {
  upcoming: withLabel('credit.installment.upcoming', { color: 'textMuted' }),
  due: withLabel('credit.installment.due', { color: 'warning' }),
  paid: withLabel('credit.installment.paid', { color: 'success' }),
  overdue: withLabel('credit.installment.overdue', { color: 'danger' }),
};

type Props = {
  installments: readonly Installment[];
  /** Offers have nothing paid yet, so the status column is left out. */
  showStatus?: boolean;
};

/** Repayment schedule: one row per instalment with its date, amount and state. */
export function InstallmentList({ installments, showStatus = false }: Props) {
  const { spacing } = useTheme();
  const { t } = useTranslation();
  return (
    <View style={{ gap: spacing[3] }} accessibilityRole="list">
      {installments.map((i) => {
        const amount = formatMoney(fromApiMoney(i.amount));
        const status = STATUS[i.status];
        const paid = fromApiMoney(i.paid);
        const part =
          i.status !== 'paid' && paid.amount > 0n
            ? t('credit.installment.partPaid', { amount: formatMoney(paid) })
            : '';
        return (
          <View
            key={i.number}
            style={[styles.row, { gap: spacing[3] }]}
            accessible
            accessibilityLabel={`${t('credit.installment.label', {
              number: i.number,
              date: formatGoalDate(i.due_date),
              amount,
            })}${showStatus ? `, ${status.label}${part}` : ''}`}
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
