import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { ArrowDownLeft, Plus } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';

import { Button, Chip, ListItem, MoneyText, useToast } from '@/components';
import type { ApiError } from '@/data';
import { useMoneyMutation } from '@/lib/query';
import { fromApiMoney, toApiMoney } from '@/lib/money';
import { useTheme } from '@/theme';

import { amountsFor, SENDERS } from '../presets';

import { ChipRow, DemoSection } from './DemoSection';

export type Props = { accounts: Schema<'Account'>[] };

/** Fund a wallet, or receive a transfer into it (DEMO-1). Both post through the mock ledger. */
export function MoneySection({ accounts }: Props) {
  const { spacing } = useTheme();
  const toast = useToast();
  const [accountId, setAccountId] = useState(accounts[0]?.id);
  const [amountIndex, setAmountIndex] = useState(1);

  const onError = (error: ApiError) => toast.show({ message: error.problem.title, tone: 'error' });
  const fund = useMoneyMutation('demo', 'fundWallet', { onError });
  const inbound = useMoneyMutation('demo', 'inboundTransfer', { onError });

  const account = accounts.find((a) => a.id === accountId) ?? accounts[0];
  if (!account) return null;
  const amounts = amountsFor(account.currency);
  const amount = amounts[amountIndex] ?? amounts[0]!;
  const sender = SENDERS[account.currency];
  const body = { account_id: account.id, amount: toApiMoney(amount) };
  const busy = fund.isPending || inbound.isPending;
  const done = (message: string) => ({
    onSuccess: () => toast.show({ message, tone: 'success' }),
  });

  return (
    <DemoSection
      title="Money in"
      description="Add demo money, or have someone send you a transfer. Both post through the ledger, like the real thing."
    >
      <View>
        {accounts.map((a) => (
          <ListItem
            key={a.id}
            title={`${a.currency} wallet`}
            trailing={
              <MoneyText
                value={fromApiMoney(a.available_balance)}
                variant="label"
                label={`${a.currency} wallet balance`}
              />
            }
          />
        ))}
      </View>
      {accounts.length > 1 && (
        <ChipRow label="Wallet">
          {accounts.map((a) => (
            <Chip
              key={a.id}
              label={a.currency}
              selected={a.id === account.id}
              onPress={() => setAccountId(a.id)}
            />
          ))}
        </ChipRow>
      )}
      <ChipRow label="Amount">
        {amounts.map((m, i) => (
          <Chip
            key={m.amount.toString()}
            label={formatMoney(m, { trimZeroMinor: true })}
            selected={m === amount}
            onPress={() => setAmountIndex(i)}
          />
        ))}
      </ChipRow>
      <View style={{ gap: spacing[2] }}>
        <Button
          label="Add demo money"
          icon={Plus}
          loading={fund.isPending}
          disabled={busy}
          onPress={() =>
            fund.mutate(
              { body },
              done(`${formatMoney(amount)} added to your ${account.currency} wallet`),
            )
          }
        />
        <Button
          label={`Receive from ${sender.name}`}
          icon={ArrowDownLeft}
          variant="secondary"
          loading={inbound.isPending}
          disabled={busy}
          onPress={() =>
            inbound.mutate(
              {
                body: {
                  ...body,
                  sender_name: sender.name,
                  sender_bank: sender.bank,
                  narration: sender.narration,
                },
              },
              done(`${sender.name} sent you ${formatMoney(amount)}`),
            )
          }
        />
      </View>
    </DemoSection>
  );
}
