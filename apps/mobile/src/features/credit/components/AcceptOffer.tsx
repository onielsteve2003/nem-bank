import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Button, Switch, Text } from '@/components';
import { ConfirmSheet } from '@/features/transfers/components/ConfirmSheet';
import { sendErrorMessage } from '@/features/transfers/confirm';
import { isApiError } from '@/data';
import { fromApiMoney } from '@/lib/money';
import { useMoneyMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { tenorLabel } from '../credit';

type Props = {
  offer: Schema<'LoanOffer'>;
  /** A slider moved and the new offer is not in yet: wait before borrowing. */
  pricing?: boolean;
  /** The offer ran out before it was accepted: price it again. */
  onExpired: () => void;
};

/**
 * Accept a loan offer (CRD-3): choose auto-repay, approve with the PIN or
 * Face ID, and the principal is paid into the naira account in one
 * idempotent call. Then the loan opens with its schedule.
 */
export function AcceptOffer({ offer, pricing = false, onExpired }: Props) {
  const router = useRouter();
  const { spacing } = useTheme();
  const [autoRepay, setAutoRepay] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const accounts = useRepoQuery('accounts', 'list');
  const naira = accounts.data?.data.find((a) => a.currency === 'NGN');
  const accept = useMoneyMutation('credit', 'acceptOffer');
  const principal = formatMoney(fromApiMoney(offer.principal), { trimZeroMinor: true });

  const run = async () => {
    if (!naira) return false;
    setError(undefined);
    try {
      const loan = await accept.mutateAsync({
        body: {
          offer_id: offer.offer_id,
          disbursement_account_id: naira.id,
          auto_repay: autoRepay,
        },
      });
      setConfirming(false);
      router.replace({ pathname: '/credit/[id]', params: { id: loan.id, new: '1' } });
      return true;
    } catch (e) {
      if (isApiError(e) && e.code === 'offer_expired') {
        setConfirming(false);
        setError('That offer ran out. Here is a fresh one: check it and borrow again.');
        onExpired();
        return false;
      }
      setError(sendErrorMessage(e as Error).message);
      return false;
    }
  };

  return (
    <View style={{ gap: spacing[2] }}>
      <Switch
        label="Repay automatically"
        description="Each payment is taken from your naira account on its due date."
        value={autoRepay}
        onValueChange={setAutoRepay}
      />
      {error && !confirming && (
        <Text variant="bodySmall" color="danger" accessibilityRole="alert">
          {error}
        </Text>
      )}
      <Button
        label={`Borrow ${principal}`}
        disabled={!naira || pricing}
        onPress={() => {
          accept.resetIntent();
          setConfirming(true);
        }}
      />
      <ConfirmSheet
        open={confirming}
        onClose={() => setConfirming(false)}
        subtitle={`Borrow ${principal} into your naira account and repay ${formatMoney(
          fromApiMoney(offer.total_repayment),
        )} over ${tenorLabel(offer.tenor_days)}`}
        onApproved={run}
        error={error}
      />
    </View>
  );
}
