import type { Schema } from '@nem/contracts';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  CircleCheck,
  CircleX,
  Clock,
  Send,
  ShieldAlert,
  ShieldQuestion,
  Undo2,
  type LucideIcon,
} from '@/components/icons';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Button,
  Card,
  ErrorState,
  Icon,
  MoneyText,
  RiskReasonList,
  Screen,
  Skeleton,
  SkeletonGroup,
  StatusTimeline,
  Text,
  type TextColor,
} from '@/components';
import { formatDateTime } from '@/features/transactions/format';
import { haptic } from '@/lib/haptics';
import { fromApiMoney } from '@/lib/money';
import { useMoneyMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { StepUpSheet } from '../components/StepUpSheet';
import { HOLD_TITLE } from '../hold';
import {
  canCancel,
  isSettling,
  outcomeOf,
  riskReasonsOf,
  sendErrorMessage,
  type Outcome,
} from '../confirm';
import { useTranslation } from 'react-i18next';
import i18n from '@/lib/i18n';

type Transfer = Schema<'Transfer'>;

const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' });

const HEADLINE: Record<
  Outcome,
  { icon: LucideIcon; color: TextColor; message: (t: Transfer) => string }
> = {
  sent: {
    icon: CircleCheck,
    color: 'success',
    message: (t) => i18n.t('transfers.result.sent.message', { name: t.recipient.name }),
  },
  processing: {
    icon: Send,
    color: 'info',
    message: (t) =>
      i18n.t('transfers.result.processing.message', {
        bank: t.recipient.bank_name,
        name: t.recipient.name,
      }),
  },
  step_up: {
    icon: ShieldQuestion,
    color: 'warning',
    message: () => i18n.t('transfers.result.step_up.message'),
  },
  delayed: {
    icon: Clock,
    color: 'warning',
    message: (t) =>
      i18n.t('transfers.result.delayed.message', {
        time: t.release_at ? timeOf(t.release_at) : i18n.t('transfers.result.delayed.endOfWait'),
      }),
  },
  held: {
    icon: ShieldAlert,
    color: 'warning',
    message: () => i18n.t('transfers.result.held.message'),
  },
  reversed: {
    icon: Undo2,
    color: 'info',
    message: (t) => {
      const values = { bank: t.recipient.bank_name, name: t.recipient.name.split(' ')[0] };
      return t.reversal
        ? i18n.t('transfers.result.reversed.messageAt', {
            ...values,
            time: timeOf(t.reversal.reversed_at),
          })
        : i18n.t('transfers.result.reversed.message', values);
    },
  },
  stopped: {
    icon: CircleX,
    color: 'danger',
    message: (t) =>
      i18n.t(
        t.status === 'cancelled'
          ? 'transfers.result.stopped.cancelled'
          : 'transfers.result.stopped.failed',
      ),
  },
};

/** Fallback for transports without realtime: poll fast while it moves, slowly while it waits. */
const POLL_MOVING_MS = 2_000;
const POLL_WAITING_MS = 15_000;

/** The step the customer is waiting for, while the transfer is still moving. */
function nextStep(t: Transfer): string | undefined {
  if (!isSettling(t.status)) return undefined;
  return t.rail === 'internal'
    ? i18n.t('transfers.result.credited', { name: t.recipient.name })
    : i18n.t('transfers.result.receivedBy', { bank: t.recipient.bank_name });
}

/**
 * What happened after confirming (TRF-6, TRF-7): sent, on its way, waiting with
 * the bank's plain-language reasons, or returned. The status timeline updates
 * live (`transfer.updated` events, polling as the fallback); a failed transfer
 * to another bank is reversed automatically and shown as money returned.
 */
export function TransferResultScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [checking, setChecking] = useState(false);
  const [cancelError, setCancelError] = useState<string>();
  const { t: tr } = useTranslation();
  const transfer = useRepoQuery(
    'transfers',
    'get',
    { path: { transfer_id: id } },
    {
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        if (!status) return false;
        if (isSettling(status)) return POLL_MOVING_MS;
        return canCancel(status) ? POLL_WAITING_MS : false;
      },
    },
  );
  const status = transfer.data?.status;
  const seen = useRef(status);
  // Feel the moment it lands (or comes back), not just the first render.
  useEffect(() => {
    const before = seen.current;
    seen.current = status;
    if (!before || before === status || !status) return;
    if (status === 'completed') haptic('success');
    else if (status === 'failed' || status === 'reversed') haptic('warning');
  }, [status]);
  const cancel = useMoneyMutation('transfers', 'cancel');

  const done = () => router.dismissTo('/');

  if (!transfer.data) {
    return (
      <Screen edges={['top', 'bottom']}>
        {transfer.isError ? (
          <ErrorState title={tr('common.paymentFailed')} onRetry={() => transfer.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel={tr('transfers.result.loading')}>
            <Skeleton height={64} width={64} />
            <Skeleton height={28} width={200} />
            <Skeleton height={20} />
          </SkeletonGroup>
        )}
      </Screen>
    );
  }

  const t = transfer.data;
  const outcome = outcomeOf(t);
  const head = HEADLINE[outcome];
  const reasons = riskReasonsOf(t);
  const waiting = outcome === 'step_up' || outcome === 'delayed';

  const cancelIt = () => {
    setCancelError(undefined);
    cancel.mutate(
      { path: { transfer_id: t.id } },
      { onError: (e) => setCancelError(sendErrorMessage(e).message) },
    );
  };

  return (
    <Screen
      edges={['top', 'bottom']}
      footer={
        <View style={{ gap: spacing[2] }}>
          {cancelError && (
            <Text variant="bodySmall" color="danger" accessibilityLiveRegion="assertive">
              {cancelError}
            </Text>
          )}
          {waiting && (
            <Button
              label={
                outcome === 'delayed'
                  ? tr('transfers.holdScreen.sendNow')
                  : tr('transfers.holdScreen.confirmMe')
              }
              onPress={() => setChecking(true)}
            />
          )}
          {canCancel(t.status) && (
            <Button
              label={tr('transfers.holdScreen.cancel')}
              variant="secondary"
              loading={cancel.isPending}
              onPress={cancelIt}
            />
          )}
          <Button
            label={tr('common.done')}
            variant={waiting ? 'ghost' : 'primary'}
            onPress={done}
          />
        </View>
      }
    >
      <View style={[styles.center, { gap: spacing[3], paddingTop: spacing[8] }]}>
        <Icon icon={head.icon} size="xl" color={head.color} />
        <Text variant="title" accessibilityRole="header" accessibilityLiveRegion="polite">
          {tr(`transfers.result.${outcome}.title`)}
        </Text>
        <MoneyText value={fromApiMoney(t.amount)} variant="display" label={tr('common.amount')} />
        <Text color="textMuted" style={styles.text}>
          {tr('transfers.result.to', { name: t.recipient.name, bank: t.recipient.bank_name })}
        </Text>
        <Text style={styles.text}>{head.message(t)}</Text>
      </View>

      <Card>
        <Text variant="label" color="textMuted" accessibilityRole="header">
          {tr('common.status')}
        </Text>
        <View style={{ marginTop: spacing[3] }}>
          <StatusTimeline steps={t.timeline} formatAt={formatDateTime} next={nextStep(t)} />
        </View>
      </Card>

      {reasons.length > 0 && outcome !== 'sent' && outcome !== 'processing' && (
        <RiskReasonList
          reasons={reasons}
          title={
            outcome === 'held'
              ? tr('transfers.result.whyChecking')
              : tr('transfers.result.whyAsking')
          }
        />
      )}
      {HOLD_TITLE[outcome] && (
        <Button
          label={HOLD_TITLE[outcome]}
          icon={ShieldQuestion}
          variant="secondary"
          onPress={() => router.push({ pathname: '/send/held/[id]', params: { id: t.id } })}
        />
      )}

      <Text variant="caption" color="textMuted" style={styles.text}>
        {tr('transfers.result.reference', { reference: t.reference })}
      </Text>

      <StepUpSheet
        key={checking ? t.id : 'none'}
        transferId={checking ? t.id : null}
        reason={reasons[0]?.label ?? head.message(t)}
        onClose={() => setChecking(false)}
        onReleased={() => setChecking(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center' },
  text: { textAlign: 'center' },
});
