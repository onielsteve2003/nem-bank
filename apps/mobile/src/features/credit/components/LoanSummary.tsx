import type { Schema } from '@nem/contracts';
import { formatMoney, money } from '@nem/shared';
import { StyleSheet, View } from 'react-native';

import { Badge, Card, MoneyText, Text } from '@/components';
import { formatGoalDate } from '@/features/savings/goals';
import { fromApiMoney } from '@/lib/money';
import { useTheme } from '@/theme';

import { LOAN_STATUS, loanTotalKobo, repaidPct } from '../credit';

type Props = {
  loan: Schema<'Loan'>;
  /** On the hub the card opens the loan. */
  onPress?: () => void;
};

/** What is left to repay, how far along the loan is, and the next payment. */
export function LoanSummary({ loan, onPress }: Props) {
  const { colors, radius, spacing } = useTheme();
  const status = LOAN_STATUS[loan.status];
  const pct = repaidPct(loan);
  const total = formatMoney(money(loanTotalKobo(loan), 'NGN'));
  const next = loan.next_due;
  const nextLeft = next
    ? money(BigInt(next.amount.amount_minor) - BigInt(next.paid.amount_minor), 'NGN')
    : null;

  return (
    <Card
      onPress={onPress}
      accessibilityLabel={onPress ? `Your loan, ${status.label}` : undefined}
      accessibilityHint={onPress ? 'Opens the loan and its schedule' : undefined}
    >
      <View style={{ gap: spacing[3] }}>
        <View style={[styles.row, styles.between]}>
          <Text variant="bodySmall" color="textMuted">
            Left to repay
          </Text>
          <Badge label={status.label} tone={status.tone} />
        </View>
        <MoneyText
          value={fromApiMoney(loan.outstanding)}
          variant="amountLarge"
          label="Left to repay"
        />
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={`${pct}% of ${total} repaid`}
          accessibilityValue={{ min: 0, max: 100, now: pct }}
          style={[styles.track, { backgroundColor: colors.border, borderRadius: radius.pill }]}
        >
          <View
            style={[
              styles.fill,
              {
                width: `${pct}%`,
                borderRadius: radius.pill,
                backgroundColor: loan.status === 'overdue' ? colors.danger : colors.primary,
              },
            ]}
          />
        </View>
        <Text variant="bodySmall" color="textMuted">
          {next && nextLeft
            ? `Next payment ${formatMoney(nextLeft)} on ${formatGoalDate(next.due_date)}${
                loan.auto_repay ? ', taken automatically' : ''
              }`
            : `All ${total} repaid`}
        </Text>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  between: { justifyContent: 'space-between' },
  track: { height: 8, overflow: 'hidden' },
  fill: { height: '100%' },
});
