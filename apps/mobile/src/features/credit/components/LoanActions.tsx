import type { Schema } from '@nem/contracts';
import { formatMoney, money } from '@nem/shared';
import { CalendarClock, HandCoins, TriangleAlert } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Icon, Switch, Text, useToast } from '@/components';
import i18n from '@/lib/i18n';
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
  const { t } = useTranslation();
  const toast = useToast();
  const [repaying, setRepaying] = useState(false);
  const accounts = useRepoQuery('accounts', 'list');
  const naira = accounts.data?.data.find((a) => a.currency === 'NGN');
  const update = useRepoMutation('credit', 'updateLoan', {
    invalidates: [['credit']],
    onError: () => toast.show({ message: i18n.t('credit.actions.autoFailed'), tone: 'error' }),
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
              accessibilityLabel={t(
                overdue ? 'credit.actions.overdue' : 'credit.actions.dueToday',
                {
                  amount: dueText,
                },
              )}
            >
              <Icon
                icon={overdue ? TriangleAlert : CalendarClock}
                color={overdue ? 'danger' : 'warning'}
              />
              <Text variant="bodyStrong" style={styles.flex}>
                {t(overdue ? 'credit.actions.overdue' : 'credit.actions.dueToday', {
                  amount: dueText,
                })}
              </Text>
            </View>
            <Text variant="bodySmall" color="textMuted">
              {overdue && loan.auto_repay
                ? t('credit.actions.autoMissed')
                : overdue
                  ? t('credit.actions.overdueHelp')
                  : t('credit.actions.autoOff')}
            </Text>
            <Button
              label={t('credit.actions.payNow', { amount: dueText })}
              disabled={!naira}
              onPress={() => setRepaying(true)}
            />
          </View>
        </Card>
      )}

      <Card>
        <View style={{ gap: spacing[2] }}>
          <Switch
            label={t('common.repayAutomatically')}
            description={t('common.repayAutomaticallyHelp')}
            value={autoRepay}
            disabled={update.isPending}
            onValueChange={(v) =>
              update.mutate({ path: { loan_id: loan.id }, body: { auto_repay: v } })
            }
          />
          <Button
            label={t('credit.actions.repayEarly')}
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
