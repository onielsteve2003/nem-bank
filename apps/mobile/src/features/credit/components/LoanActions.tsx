import type { Schema } from '@nem/contracts';
import { formatMoney, money } from '@nem/shared';
import { CalendarClock, HandCoins, TriangleAlert } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Icon, Switch, Text, useToast } from '@/components';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { dueNowKobo } from '../credit';
import { RepaySheet } from './RepaySheet';

type Props = { loan: Schema<'Loan'> };

/**
 * What the customer can do with a loan still being repaid (CRD-4): pay what
 * is overdue or due today, repay early or pay it off, and turn auto-repay on
 * or off.
 */
export function LoanActions({ loan }: Props) {
  const { spacing } = useTheme();
  const toast = useToast();
  const [repaying, setRepaying] = useState(false);
  const accounts = useRepoQuery('accounts', 'list');
  const naira = accounts.data?.data.find((a) => a.currency === 'NGN');
  const update = useRepoMutation('credit', 'updateLoan', {
    invalidates: [['credit']],
    onError: () =>
      toast.show({ message: "We couldn't change auto-repay. Try again.", tone: 'error' }),
  });
  const due = dueNowKobo(loan);
  const dueText = formatMoney(money(due, 'NGN'));
  const overdue = loan.status === 'overdue';
  const autoRepay = update.isPending
    ? (update.variables?.body.auto_repay ?? loan.auto_repay)
    : loan.auto_repay;

  return (
    <>
      {due > 0n && (overdue || !loan.auto_repay) && (
        <Card>
          <View style={{ gap: spacing[3] }}>
            <View
              style={[styles.row, { gap: spacing[3] }]}
              accessible
              accessibilityRole="alert"
              accessibilityLabel={overdue ? `${dueText} is overdue` : `${dueText} is due today`}
            >
              <Icon
                icon={overdue ? TriangleAlert : CalendarClock}
                color={overdue ? 'danger' : 'warning'}
              />
              <Text variant="bodyStrong" style={styles.flex}>
                {overdue ? `${dueText} is overdue` : `${dueText} is due today`}
              </Text>
            </View>
            <Text variant="bodySmall" color="textMuted">
              {overdue && loan.auto_repay
                ? "We couldn't take it automatically: there wasn't enough in your naira account. Add money or pay it now."
                : overdue
                  ? 'Pay it now to bring your loan back on track. Late payments lower what you can borrow next time.'
                  : 'Auto-repay is off, so pay it today to stay on track.'}
            </Text>
            <Button
              label={`Pay ${dueText} now`}
              disabled={!naira}
              onPress={() => setRepaying(true)}
            />
          </View>
        </Card>
      )}

      <Card>
        <View style={{ gap: spacing[2] }}>
          <Switch
            label="Repay automatically"
            description="Each payment is taken from your naira account on its due date."
            value={autoRepay}
            disabled={update.isPending}
            onValueChange={(v) =>
              update.mutate({ path: { loan_id: loan.id }, body: { auto_repay: v } })
            }
          />
          <Button
            label="Repay early or pay off"
            icon={HandCoins}
            variant="secondary"
            disabled={!naira}
            onPress={() => setRepaying(true)}
          />
        </View>
      </Card>

      {repaying && naira && (
        <RepaySheet loan={loan} account={naira} onClose={() => setRepaying(false)} />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
