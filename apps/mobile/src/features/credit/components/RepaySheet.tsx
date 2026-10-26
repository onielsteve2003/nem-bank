import type { Schema } from '@nem/contracts';
import { compare, formatMoney, money, subtract } from '@nem/shared';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AmountInput, BottomSheet, Button, Chip, Text } from '@/components';
import { typedFromKobo, typedNaira } from '@/features/transfers/amount';
import { ConfirmSheet } from '@/features/transfers/components/ConfirmSheet';
import { sendErrorMessage } from '@/features/transfers/confirm';
import { fromApiMoney, toApiMoney } from '@/lib/money';
import { useMoneyMutation } from '@/lib/query';
import { useTheme } from '@/theme';

import { dueNowKobo, nextLeftKobo } from '../credit';

type Props = {
  loan: Schema<'Loan'>;
  /** The naira account the repayment comes from. */
  account: Schema<'Account'>;
  onClose: () => void;
};

const naira = (kobo: bigint) => formatMoney(money(kobo, 'NGN'));

/**
 * Repay a loan now (CRD-4): what is overdue, the next payment, any amount, or
 * pay it off today with the unused interest given back. PIN or Face ID, one
 * idempotent call. Mount it only while open.
 */
export function RepaySheet({ loan, account, onClose }: Props) {
  const { spacing } = useTheme();
  const overdue = dueNowKobo(loan);
  const next = nextLeftKobo(loan);
  const owed = fromApiMoney(loan.outstanding);
  const payoff = loan.payoff_amount ? fromApiMoney(loan.payoff_amount) : owed;
  const saving = subtract(owed, payoff);
  const [typed, setTyped] = useState(() => typedFromKobo(overdue > 0n ? overdue : next));
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const repay = useMoneyMutation('credit', 'repay');

  const amount = typedNaira(typed);
  const available = fromApiMoney(account.available_balance);
  const overPayoff = amount !== null && compare(amount, payoff) > 0;
  const overBalance = amount !== null && compare(amount, available) > 0;
  const paysOff = amount !== null && compare(amount, payoff) === 0;

  const run = async () => {
    if (!amount) return false;
    setError(undefined);
    try {
      await repay.mutateAsync({
        path: { loan_id: loan.id },
        body: { amount: toApiMoney(amount), account_id: account.id },
      });
      setConfirming(false);
      onClose();
      return true;
    } catch (e) {
      setError(sendErrorMessage(e as Error).message);
      return false;
    }
  };

  const options: { label: string; kobo: bigint }[] = [
    ...(overdue > 0n ? [{ label: `Overdue ${naira(overdue)}`, kobo: overdue }] : []),
    ...(overdue === 0n && next > 0n ? [{ label: `Next payment ${naira(next)}`, kobo: next }] : []),
    { label: `Pay off ${naira(payoff.amount)}`, kobo: payoff.amount },
  ];

  return (
    <>
      <BottomSheet open={!confirming} onClose={onClose} title="Repay your loan">
        <View style={{ gap: spacing[4] }}>
          <View accessibilityRole="radiogroup" style={[styles.chips, { gap: spacing[2] }]}>
            {options.map((o) => (
              <Chip
                key={o.label}
                label={o.label}
                selected={amount?.amount === o.kobo}
                onPress={() => setTyped(typedFromKobo(o.kobo))}
              />
            ))}
          </View>
          <AmountInput
            currency="NGN"
            value={typed}
            onChangeValue={setTyped}
            maxWholeDigits={9}
            help={`${formatMoney(available)} available in your naira account`}
            error={
              overPayoff
                ? `${formatMoney(payoff)} clears the whole loan today`
                : overBalance
                  ? 'More than you have in your naira account'
                  : undefined
            }
          />
          <Text variant="bodySmall" color="textMuted">
            {saving.amount > 0n
              ? `Paying off today costs ${formatMoney(payoff)}: ${formatMoney(saving)} less than the ${formatMoney(owed)} left, because you don't pay interest for the days you no longer borrow.`
              : `${formatMoney(owed)} is left to repay.`}
          </Text>
          {error && !confirming && (
            <Text variant="bodySmall" color="danger" accessibilityRole="alert">
              {error}
            </Text>
          )}
          <Button
            label={
              paysOff
                ? 'Pay off the loan'
                : amount
                  ? `Repay ${formatMoney(amount, { trimZeroMinor: true })}`
                  : 'Repay'
            }
            disabled={!amount || overPayoff || overBalance}
            onPress={() => {
              repay.resetIntent();
              setConfirming(true);
            }}
          />
        </View>
      </BottomSheet>
      <ConfirmSheet
        open={confirming}
        onClose={() => setConfirming(false)}
        subtitle={
          amount
            ? `${paysOff ? 'Pay off your loan with' : 'Repay'} ${formatMoney(amount)} from your naira account`
            : ''
        }
        onApproved={run}
        error={error}
      />
    </>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
});
