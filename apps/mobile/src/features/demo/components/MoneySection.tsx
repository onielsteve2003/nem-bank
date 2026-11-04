import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { ArrowDownLeft, Plus } from '@/components/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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
    <DemoSection title={t('demo.money.title')} description={t('demo.money.description')}>
      <View>
        {accounts.map((a) => (
          <ListItem
            key={a.id}
            title={t('common.walletName', { name: a.currency })}
            trailing={
              <MoneyText
                value={fromApiMoney(a.available_balance)}
                variant="label"
                label={t('demo.money.walletBalance', { currency: a.currency })}
              />
            }
          />
        ))}
      </View>
      {accounts.length > 1 && (
        <ChipRow label={t('demo.money.wallet')}>
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
      <ChipRow label={t('demo.money.amount')}>
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
          label={t('demo.money.add')}
          icon={Plus}
          loading={fund.isPending}
          disabled={busy}
          onPress={() =>
            fund.mutate(
              { body },
              done(
                t('demo.money.added', {
                  amount: formatMoney(amount),
                  currency: account.currency,
                }),
              ),
            )
          }
        />
        <Button
          label={t('demo.money.receive', { name: sender.name })}
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
              done(t('demo.money.received', { name: sender.name, amount: formatMoney(amount) })),
            )
          }
        />
      </View>
    </DemoSection>
  );
}
