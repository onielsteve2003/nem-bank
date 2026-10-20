import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { useRouter } from 'expo-router';
import { Lock, UserSearch } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  Screen,
  Skeleton,
  SkeletonGroup,
  Switch,
  Text,
} from '@/components';
import { fromApiMoney, toApiMoney } from '@/lib/money';
import { useMoneyMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { typedNaira } from '../amount';
import { ConfirmSheet } from '../components/ConfirmSheet';
import { QuoteSummary } from '../components/QuoteSummary';
import { SendHeader } from '../components/SendHeader';
import { StepUpSheet } from '../components/StepUpSheet';
import { riskReasonsOf, sendErrorMessage } from '../confirm';
import { copVerdict } from '../recipient';
import { destinationOf, useSendDraft } from '../sendDraft';

type Transfer = Schema<'Transfer'>;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.between}>
      <Text color="textMuted">{label}</Text>
      <Text variant="bodyStrong" style={styles.value} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

/**
 * Check everything once more, then confirm (TRF-5). Confirming takes the PIN or
 * Face ID; the transfer goes out device-signed with one idempotency key, so a
 * double tap or a retry after a timeout never sends twice. A step-up asked for
 * by the risk engine (TRF-6) is finished here; every other outcome opens the
 * result screen.
 */
export function ReviewScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const recipient = useSendDraft((s) => s.recipient);
  const typed = useSendDraft((s) => s.amount);
  const narration = useSendDraft((s) => s.narration);
  const clearDraft = useSendDraft((s) => s.clear);
  const [save, setSave] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const [stepUp, setStepUp] = useState<Transfer | null>(null);

  const accounts = useRepoQuery('accounts', 'list');
  const source = accounts.data?.data.find((a) => a.currency === 'NGN');
  const amount = typedNaira(typed);
  // The same request as the amount screen's, so its quote comes straight from the cache.
  const quote = useRepoQuery(
    'transfers',
    'quote',
    amount && source && recipient
      ? {
          body: {
            source_account_id: source.id,
            destination: destinationOf(recipient),
            amount: toApiMoney(amount),
          },
        }
      : undefined,
    { enabled: Boolean(amount && source && recipient) },
  );
  const send = useMoneyMutation('transfers', 'create');

  const finish = useCallback(
    (transfer: Transfer) => {
      setConfirming(false);
      setStepUp(null);
      clearDraft();
      router.replace({ pathname: '/send/result/[id]', params: { id: transfer.id } });
    },
    [clearDraft, router],
  );

  const onApproved = useCallback(async () => {
    if (!recipient || !amount || !source || !quote.data) return false;
    setSendError(undefined);
    try {
      const transfer = await send.mutateAsync({
        body: {
          source_account_id: source.id,
          destination: destinationOf(recipient),
          amount: toApiMoney(amount),
          ...(narration ? { narration } : {}),
          quote_id: quote.data.quote_id,
          save_beneficiary: save,
        },
      });
      if (transfer.status === 'pending_step_up') {
        setConfirming(false);
        setStepUp(transfer);
      } else {
        finish(transfer);
      }
      return true;
    } catch (e) {
      const { message, requote } = sendErrorMessage(e as Error);
      setSendError(message);
      if (requote) {
        setConfirming(false);
        void quote.refetch();
      }
      return false;
    }
  }, [recipient, amount, source, quote, send, narration, save, finish]);

  if (!recipient || !amount) {
    return (
      <Screen header={<SendHeader title="Review" />} edges={['top', 'bottom']}>
        <EmptyState
          icon={UserSearch}
          title="Nothing to review yet"
          message="Choose who to pay and how much first."
          actionLabel="Start again"
          onAction={() => router.replace('/send')}
        />
      </Screen>
    );
  }

  const verdict = recipient.nameMatch ? copVerdict(recipient.nameMatch, recipient.name) : null;
  const firstName = recipient.name.split(' ')[0];
  const total = quote.data
    ? formatMoney(fromApiMoney(quote.data.total_debit))
    : formatMoney(amount);
  const stepUpReason =
    (stepUp && riskReasonsOf(stepUp)[0]?.label) ??
    'This payment needs one more check before it goes.';

  return (
    <Screen
      header={<SendHeader title="Review" />}
      edges={['top', 'bottom']}
      footer={
        <View style={{ gap: spacing[2] }}>
          {sendError && !confirming && (
            <Text variant="bodySmall" color="danger" accessibilityLiveRegion="assertive">
              {sendError}
            </Text>
          )}
          <Button
            label={`Send ${formatMoney(amount)}`}
            icon={Lock}
            disabled={!quote.data || !source}
            loading={send.isPending}
            onPress={() => setConfirming(true)}
          />
        </View>
      }
    >
      <Card>
        <View style={{ gap: spacing[3] }}>
          <View style={[styles.row, { gap: spacing[3] }]}>
            <Avatar name={recipient.name} size="lg" ring={recipient.kind === 'nem'} />
            <View style={styles.flex}>
              <Text variant="bodyStrong" numberOfLines={1}>
                {recipient.name}
              </Text>
              <Text variant="bodySmall" color="textMuted" numberOfLines={1}>
                {recipient.nemtag
                  ? `@${recipient.nemtag} · Nem user`
                  : `${recipient.bankName} · ${recipient.accountNumber}`}
              </Text>
            </View>
          </View>
          {verdict && (
            <View style={styles.start}>
              <Badge label={verdict.title} tone={verdict.tone} />
            </View>
          )}
          <Row label="Amount" value={formatMoney(amount)} />
          <Row label="Note" value={narration || `Transfer to ${recipient.name}`} />
          <Row label="From" value="Naira wallet" />
        </View>
      </Card>

      {quote.data ? (
        <QuoteSummary quote={quote.data} updating={quote.isFetching} />
      ) : quote.isError ? (
        <ErrorState title="We couldn't price this transfer" onRetry={() => quote.refetch()} />
      ) : (
        <SkeletonGroup accessibilityLabel="Loading the fee">
          <Skeleton height={96} />
        </SkeletonGroup>
      )}

      {!recipient.beneficiaryId && (
        <Switch
          label={`Save ${firstName} for next time`}
          description="Saved people are quicker to pay and easier to check."
          value={save}
          onValueChange={setSave}
        />
      )}

      <View style={[styles.row, { gap: spacing[2] }]}>
        <Icon icon={Lock} size="sm" color="textMuted" />
        <Text variant="caption" color="textMuted" style={styles.flex}>
          Signed by this phone and sent once, even if you tap twice.
        </Text>
      </View>

      <ConfirmSheet
        open={confirming}
        onClose={() => setConfirming(false)}
        subtitle={`Send ${total} to ${firstName}`}
        onApproved={onApproved}
        error={sendError}
      />
      <StepUpSheet
        key={stepUp?.id ?? 'none'}
        transferId={stepUp?.id ?? null}
        reason={stepUpReason}
        onClose={() => {
          // Left unconfirmed, the transfer waits: the result screen offers the check again or cancel.
          if (stepUp) finish(stepUp);
        }}
        onReleased={finish}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  between: { flexDirection: 'row', justifyContent: 'space-between', gap: 16 },
  value: { flexShrink: 1, textAlign: 'right' },
  start: { alignSelf: 'flex-start' },
  flex: { flex: 1 },
});
