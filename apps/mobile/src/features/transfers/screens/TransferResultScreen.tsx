import type { Schema } from '@nem/contracts';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  CircleCheck,
  CircleX,
  Clock,
  Send,
  ShieldAlert,
  ShieldQuestion,
  type LucideIcon,
} from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Button,
  ErrorState,
  Icon,
  MoneyText,
  RiskReasonList,
  Screen,
  Skeleton,
  SkeletonGroup,
  Text,
  type TextColor,
} from '@/components';
import { fromApiMoney } from '@/lib/money';
import { useMoneyMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { StepUpSheet } from '../components/StepUpSheet';
import { canCancel, outcomeOf, riskReasonsOf, sendErrorMessage, type Outcome } from '../confirm';

type Transfer = Schema<'Transfer'>;

const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' });

const HEADLINE: Record<
  Outcome,
  { icon: LucideIcon; color: TextColor; title: string; message: (t: Transfer) => string }
> = {
  sent: {
    icon: CircleCheck,
    color: 'success',
    title: 'Sent',
    message: (t) => `${t.recipient.name} has it now.`,
  },
  processing: {
    icon: Send,
    color: 'info',
    title: 'On its way',
    message: (t) => `${t.recipient.bank_name} usually credits ${t.recipient.name} within minutes.`,
  },
  step_up: {
    icon: ShieldQuestion,
    color: 'warning',
    title: 'Confirm it is you',
    message: () => 'This payment waits until you pass one more check. Nothing has gone yet.',
  },
  delayed: {
    icon: Clock,
    color: 'warning',
    title: 'Scheduled for safety',
    message: (t) =>
      `First large payment to someone new, so it goes at ${
        t.release_at ? timeOf(t.release_at) : 'the end of the wait'
      }. Send it now with one more check, or cancel it before then.`,
  },
  held: {
    icon: ShieldAlert,
    color: 'warning',
    title: 'Held for a quick review',
    message: () =>
      'A person at Nem checks it first. The money is put aside, not sent, and we tell you as soon as it is decided.',
  },
  stopped: {
    icon: CircleX,
    color: 'danger',
    title: 'Not sent',
    message: (t) =>
      t.status === 'cancelled'
        ? 'You cancelled it. The money is back in your available balance.'
        : 'This payment did not go through. Any money held for it is back in your balance.',
  },
};

/**
 * What happened after confirming (TRF-6): sent, on its way, or waiting with the
 * bank's plain-language reasons and what the customer can do about it.
 */
export function TransferResultScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [checking, setChecking] = useState(false);
  const [cancelError, setCancelError] = useState<string>();
  const transfer = useRepoQuery('transfers', 'get', { path: { transfer_id: id } });
  const cancel = useMoneyMutation('transfers', 'cancel');

  const done = () => router.dismissTo('/');

  if (!transfer.data) {
    return (
      <Screen edges={['top', 'bottom']}>
        {transfer.isError ? (
          <ErrorState title="We couldn't load this payment" onRetry={() => transfer.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel="Loading the payment">
            <Skeleton height={64} width={64} />
            <Skeleton height={28} width={200} />
            <Skeleton height={20} />
          </SkeletonGroup>
        )}
      </Screen>
    );
  }

  const t = transfer.data;
  const outcome = outcomeOf(t.status);
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
              label={outcome === 'delayed' ? 'Send now' : 'Confirm it is me'}
              onPress={() => setChecking(true)}
            />
          )}
          {canCancel(t.status) && (
            <Button
              label="Cancel payment"
              variant="secondary"
              loading={cancel.isPending}
              onPress={cancelIt}
            />
          )}
          <Button label="Done" variant={waiting ? 'ghost' : 'primary'} onPress={done} />
        </View>
      }
    >
      <View style={[styles.center, { gap: spacing[3], paddingTop: spacing[8] }]}>
        <Icon icon={head.icon} size="xl" color={head.color} />
        <Text variant="title" accessibilityRole="header" accessibilityLiveRegion="polite">
          {head.title}
        </Text>
        <MoneyText value={fromApiMoney(t.amount)} variant="display" label="Amount" />
        <Text color="textMuted" style={styles.text}>
          to {t.recipient.name} · {t.recipient.bank_name}
        </Text>
        <Text style={styles.text}>{head.message(t)}</Text>
      </View>

      {reasons.length > 0 && outcome !== 'sent' && outcome !== 'processing' && (
        <RiskReasonList
          reasons={reasons}
          title={outcome === 'held' ? 'Why we are checking' : 'Why we are asking'}
        />
      )}

      <Text variant="caption" color="textMuted" style={styles.text}>
        Reference {t.reference}
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
