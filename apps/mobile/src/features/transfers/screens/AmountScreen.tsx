import { keepPreviousData } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { MessageSquareText, UserSearch } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AmountInput,
  Avatar,
  Button,
  EmptyState,
  ErrorState,
  MoneyText,
  Screen,
  Skeleton,
  SkeletonGroup,
  Text,
  TextField,
} from '@/components';
import { fromApiMoney, toApiMoney } from '@/lib/money';
import { useRepoQuery } from '@/lib/query';
import { useDebounced } from '@/lib/useDebounced';
import { useTheme } from '@/theme';

import { amountProblem, NARRATION_MAX_LENGTH, typedNaira } from '../amount';
import { QuoteSummary } from '../components/QuoteSummary';
import { SendHeader } from '../components/SendHeader';
import { destinationOf, useSendDraft } from '../sendDraft';

const QUOTE_DELAY_MS = 300;

/**
 * How much to send (TRF-4): the custom keypad, the fee and the day's remaining
 * limit for the typed amount, and an optional note. Problems the customer can
 * fix (over the balance, over a limit) show before they ever reach confirm.
 */
export function AmountScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const recipient = useSendDraft((s) => s.recipient);
  const saveAmount = useSendDraft((s) => s.setAmount);
  const [typed, setTyped] = useState(() => useSendDraft.getState().amount);
  const [narration, setNarration] = useState(() => useSendDraft.getState().narration);

  const accounts = useRepoQuery('accounts', 'list');
  const selfLimits = useRepoQuery('security', 'getLimits');
  const source = accounts.data?.data.find((a) => a.currency === 'NGN');

  const amount = typedNaira(typed);
  const settled = useDebounced(typed, QUOTE_DELAY_MS);
  const settledAmount = typedNaira(settled);
  const quote = useRepoQuery(
    'transfers',
    'quote',
    settledAmount && source && recipient
      ? {
          body: {
            source_account_id: source.id,
            destination: destinationOf(recipient),
            amount: toApiMoney(settledAmount),
          },
        }
      : undefined,
    { enabled: Boolean(settledAmount && source && recipient), placeholderData: keepPreviousData },
  );

  if (!recipient) {
    return (
      <Screen header={<SendHeader title="Amount" />} edges={['top', 'bottom']}>
        <EmptyState
          icon={UserSearch}
          title="Choose who to pay first"
          actionLabel="Choose someone"
          onAction={() => router.replace('/send')}
        />
      </Screen>
    );
  }

  const available = source ? fromApiMoney(source.available_balance) : null;
  const single = selfLimits.data?.single_limit;
  // The quote on screen may still be for the previous amount while the new one loads.
  const current =
    quote.data && amount && quote.data.amount.amount_minor === amount.amount.toString()
      ? quote.data
      : null;
  const problem =
    amount && available
      ? amountProblem({
          amount,
          available,
          singleLimit: single ? fromApiMoney(single) : null,
          quote: current,
        })
      : null;

  const goOn = () => {
    saveAmount(typed, narration.trim());
    router.push('/send/review');
  };

  return (
    <Screen
      header={<SendHeader title="Amount" />}
      footer={<Button label="Review" disabled={!current || problem !== null} onPress={goOn} />}
      edges={['top', 'bottom']}
    >
      <View style={[styles.row, { gap: spacing[3] }]}>
        <Avatar name={recipient.name} size="md" ring={recipient.kind === 'nem'} />
        <View style={styles.flex}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {recipient.name}
          </Text>
          <Text variant="bodySmall" color="textMuted" numberOfLines={1}>
            {recipient.nemtag ? `@${recipient.nemtag} · Nem` : recipient.bankName}
          </Text>
        </View>
      </View>

      <AmountInput
        currency="NGN"
        value={typed}
        onChangeValue={setTyped}
        error={problem ?? undefined}
      />

      {available ? (
        <View style={[styles.row, styles.center, { gap: spacing[1] }]}>
          <Text variant="bodySmall" color="textMuted">
            Available
          </Text>
          <MoneyText value={available} variant="bodySmall" color="textMuted" label="Available" />
        </View>
      ) : accounts.isError ? (
        <ErrorState title="We couldn't load your balance" onRetry={() => accounts.refetch()} />
      ) : (
        <SkeletonGroup accessibilityLabel="Loading your balance">
          <Skeleton height={20} width={160} />
        </SkeletonGroup>
      )}

      {quote.data && amount ? (
        <QuoteSummary quote={quote.data} updating={!current} />
      ) : quote.isError && amount ? (
        <ErrorState title="We couldn't price this transfer" onRetry={() => quote.refetch()} />
      ) : null}

      <TextField
        label="What's it for?"
        optional
        placeholder="Rent, school fees, owambe…"
        leadingIcon={MessageSquareText}
        value={narration}
        onChangeText={setNarration}
        maxLength={NARRATION_MAX_LENGTH}
        help={`${recipient.name.split(' ')[0]} sees this on their statement.`}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { justifyContent: 'center' },
  flex: { flex: 1 },
});
