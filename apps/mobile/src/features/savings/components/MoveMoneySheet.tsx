import type { Schema } from '@nem/contracts';
import { compare, formatMoney } from '@nem/shared';
import { useState } from 'react';
import { View } from 'react-native';

import { AmountInput, BottomSheet, Button, Text } from '@/components';
import { typedFromKobo, typedNaira } from '@/features/transfers/amount';
import { ConfirmSheet } from '@/features/transfers/components/ConfirmSheet';
import { sendErrorMessage } from '@/features/transfers/confirm';
import { fromApiMoney, toApiMoney } from '@/lib/money';
import { useMoneyMutation } from '@/lib/query';
import { useTheme } from '@/theme';

interface Props {
  kind: 'deposit' | 'withdraw';
  goal: Schema<'SavingsGoal'>;
  /** The naira account money comes from or goes to. */
  account: Schema<'Account'>;
  onClose: () => void;
}

/**
 * Add money to a goal, or take it out (SAV-2). Taking it out needs the PIN or
 * Face ID; adding only moves the customer's money into their own goal.
 * Mount it only while open.
 */
export function MoveMoneySheet({ kind, goal, account, onClose }: Props) {
  const { spacing } = useTheme();
  const [typed, setTyped] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const isDeposit = kind === 'deposit';
  const mutation = useMoneyMutation('savings', kind, {
    invalidates: [['savings'], ['accounts'], ['transactions']],
  });

  const amount = typedNaira(typed);
  const limit = fromApiMoney(isDeposit ? account.available_balance : goal.balance);
  const tooMuch = amount !== null && compare(amount, limit) > 0;
  const verb = isDeposit ? 'Add' : 'Withdraw';

  const run = async () => {
    if (!amount) return false;
    setError(undefined);
    try {
      await mutation.mutateAsync({
        path: { goal_id: goal.id },
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

  return (
    <>
      <BottomSheet
        open={!confirming}
        onClose={onClose}
        title={isDeposit ? `Add money to ${goal.name}` : `Withdraw from ${goal.name}`}
      >
        <View style={{ gap: spacing[4] }}>
          <AmountInput
            currency="NGN"
            value={typed}
            onChangeValue={setTyped}
            maxWholeDigits={9}
            help={
              isDeposit
                ? `${formatMoney(limit)} available in your naira account`
                : `${formatMoney(limit)} in this goal`
            }
            error={
              tooMuch
                ? isDeposit
                  ? 'More than you have in your naira account'
                  : 'More than is in this goal'
                : undefined
            }
          />
          {!isDeposit && limit.amount > 0n && (
            <Button
              label="Withdraw everything"
              variant="ghost"
              onPress={() => setTyped(typedFromKobo(limit.amount))}
            />
          )}
          {error && !confirming && (
            <Text variant="bodySmall" color="danger" accessibilityRole="alert">
              {error}
            </Text>
          )}
          <Button
            label={amount ? `${verb} ${formatMoney(amount, { trimZeroMinor: true })}` : verb}
            disabled={!amount || tooMuch}
            loading={isDeposit && mutation.isPending}
            onPress={() => {
              mutation.resetIntent();
              if (isDeposit) void run();
              else setConfirming(true);
            }}
          />
        </View>
      </BottomSheet>
      {!isDeposit && (
        <ConfirmSheet
          open={confirming}
          onClose={() => setConfirming(false)}
          subtitle={amount ? `Withdraw ${formatMoney(amount)} to your naira account` : ''}
          onApproved={run}
          error={error}
        />
      )}
    </>
  );
}
