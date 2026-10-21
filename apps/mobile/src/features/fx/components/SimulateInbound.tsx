import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { useRouter } from 'expo-router';
import { ArrowDownLeft } from 'lucide-react-native';
import { View } from 'react-native';

import { Button, Card, Text, useToast } from '@/components';
import { amountsFor, SENDERS } from '@/features/demo/presets';
import { toApiMoney } from '@/lib/money';
import { useMoneyMutation } from '@/lib/query';
import { useTheme } from '@/theme';

export type Props = { account: Schema<'Account'> };

/**
 * Mock bank only (FX-3): a payment from abroad arrives through the ledger the
 * way a real one would, so the wallet, the activity list and the notification
 * all update. The full set of amounts and senders lives in Demo Controls.
 */
export function SimulateInbound({ account }: Props) {
  const { spacing } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const inbound = useMoneyMutation('demo', 'inboundTransfer', {
    onError: (error) => toast.show({ message: error.problem.title, tone: 'error' }),
  });
  const sender = SENDERS[account.currency];
  const amount = amountsFor(account.currency)[1]!;

  return (
    <Card variant="outline" style={{ gap: spacing[3] }}>
      <Text variant="bodySmall" color="textMuted">
        Demo: see a payment land without waiting for a real one.
      </Text>
      <View style={{ gap: spacing[2] }}>
        <Button
          label={`Get ${formatMoney(amount, { trimZeroMinor: true })} from ${sender.name}`}
          icon={ArrowDownLeft}
          variant="secondary"
          loading={inbound.isPending}
          onPress={() =>
            inbound.mutate(
              {
                body: {
                  account_id: account.id,
                  amount: toApiMoney(amount),
                  sender_name: sender.name,
                  sender_bank: sender.bank,
                  narration: sender.narration,
                },
              },
              {
                onSuccess: () =>
                  toast.show({
                    message: `${sender.name} sent you ${formatMoney(amount)}`,
                    tone: 'success',
                  }),
              },
            )
          }
        />
        <Button
          label="More in Demo Controls"
          variant="ghost"
          onPress={() => router.push('/demo-controls')}
        />
      </View>
    </Card>
  );
}
