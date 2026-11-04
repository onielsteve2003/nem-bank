import { narrationWarning } from '@nem/shared';
import { keepPreviousData } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { MessageSquareText, UserSearch } from '@/components/icons';
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
import { ScamHint } from '../components/ScamHint';
import { SendHeader } from '../components/SendHeader';
import { destinationOf, useSendDraft } from '../sendDraft';
import { useTranslation } from 'react-i18next';

const QUOTE_DELAY_MS = 300;

/**
 * How much to send (TRF-4): the custom keypad, the fee and the day's remaining
 * limit for the typed amount, and an optional note. Problems the customer can
 * fix (over the balance, over a limit) show before they ever reach confirm.
 */
export function AmountScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const recipient = useSendDraft((s) => s.recipient);
  const saveAmount = useSendDraft((s) => s.setAmount);
  const [typed, setTyped] = useState(() => useSendDraft.getState().amount);
  const [narration, setNarration] = useState(() => useSendDraft.getState().narration);

  const accounts = useRepoQuery('accounts', 'list');
  const selfLimits = useRepoQuery('security', 'getLimits');
  const source = accounts.data?.data.find((a) => a.currency === 'NGN');

  const amount = typedNaira(typed);
  const settled = useDebounced(typed, QUOTE_DELAY_MS);
  // Checked once typing pauses, so a warning never flashes up mid-word.
  const narrationHint = narrationWarning(useDebounced(narration, QUOTE_DELAY_MS));
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
      <Screen
        header={<SendHeader title={t('transfers.amountScreen.title')} />}
        edges={['top', 'bottom']}
      >
        <EmptyState
          icon={UserSearch}
          title={t('transfers.amountScreen.chooseFirst')}
          actionLabel={t('transfers.amountScreen.choose')}
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
      header={<SendHeader title={t('transfers.amountScreen.title')} />}
      footer={
        <Button
          label={t('transfers.amountScreen.review')}
          disabled={!current || problem !== null}
          onPress={goOn}
        />
      }
      edges={['top', 'bottom']}
    >
      <View style={[styles.row, { gap: spacing[3] }]}>
        <Avatar name={recipient.name} size="md" ring={recipient.kind === 'nem'} />
        <View style={styles.flex}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {recipient.name}
          </Text>
          <Text variant="bodySmall" color="textMuted" numberOfLines={1}>
            {recipient.nemtag
              ? t('transfers.amountScreen.nem', { nemtag: recipient.nemtag })
              : recipient.bankName}
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
            {t('common.available')}
          </Text>
          <MoneyText
            value={available}
            variant="bodySmall"
            color="textMuted"
            label={t('common.available')}
          />
        </View>
      ) : accounts.isError ? (
        <ErrorState title={t('common.balanceFailed')} onRetry={() => accounts.refetch()} />
      ) : (
        <SkeletonGroup accessibilityLabel={t('common.loadingBalance')}>
          <Skeleton height={20} width={160} />
        </SkeletonGroup>
      )}

      {quote.data && amount ? (
        <QuoteSummary quote={quote.data} updating={!current} />
      ) : quote.isError && amount ? (
        <ErrorState
          title={t('transfers.amountScreen.priceFailed')}
          onRetry={() => quote.refetch()}
        />
      ) : null}

      <TextField
        label={t('transfers.amountScreen.whatFor')}
        optional
        placeholder={t('transfers.amountScreen.whatForPlaceholder')}
        leadingIcon={MessageSquareText}
        value={narration}
        onChangeText={setNarration}
        maxLength={NARRATION_MAX_LENGTH}
        help={t('transfers.amountScreen.seesThis', { name: recipient.name.split(' ')[0] })}
      />
      {narrationHint && <ScamHint reason={narrationHint} />}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { justifyContent: 'center' },
  flex: { flex: 1 },
});
