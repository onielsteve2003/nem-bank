import { formatMoney } from '@nem/shared';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { BellRing, Receipt } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Screen,
  Skeleton,
  SkeletonGroup,
  Text,
} from '@/components';
import { isApiError } from '@/data';
import { fromApiMoney } from '@/lib/money';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { SendHeader } from '../components/SendHeader';
import { SplitProgress } from '../components/SplitProgress';
import { REQUEST_STATUS, requestErrorMessage } from '../requests';
import { isSettled, remindable, remindedAgo } from '../splits';

/** Friends pay back on their own time; look again every few seconds while anyone owes. */
const POLL_MS = 5_000;

/**
 * One split bill (TRF-11): every share with whether it is paid, and a reminder
 * for those who have not (at most once a day each).
 */
export function SplitBillScreen() {
  const router = useRouter();
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const { spacing } = useTheme();
  const [message, setMessage] = useState<{ text: string; ok: boolean }>();
  const split = useRepoQuery(
    'moneyRequests',
    'getSplitBill',
    { path: { split_bill_id: id } },
    { refetchInterval: (q) => (q.state.data && !isSettled(q.state.data) ? POLL_MS : false) },
  );
  const remind = useRepoMutation('moneyRequests', 'remindSplitBill');
  const s = split.data;

  const remindAll = () => {
    if (!s) return;
    const count = remindable(s);
    setMessage(undefined);
    remind.mutate(
      { path: { split_bill_id: s.id } },
      {
        onSuccess: () =>
          setMessage({
            text: `Reminder sent to ${count} ${count === 1 ? 'person' : 'people'}.`,
            ok: true,
          }),
        onError: (e) =>
          setMessage({
            text: isApiError(e, 'rate_limited')
              ? 'Everyone still to pay was reminded in the last day.'
              : requestErrorMessage(e),
            ok: false,
          }),
      },
    );
  };

  if (!s) {
    return (
      <Screen header={<SendHeader title="Split bill" />} edges={['top', 'bottom']}>
        {split.isError ? (
          isApiError(split.error, 'not_found') ? (
            <EmptyState
              icon={Receipt}
              title="Split bill not found"
              message="It may have been made on another device."
              actionLabel="See your split bills"
              onAction={() => router.replace('/send/splits')}
            />
          ) : (
            <ErrorState title="We couldn't load this split" onRetry={() => split.refetch()} />
          )
        ) : (
          <SkeletonGroup accessibilityLabel="Loading the split bill">
            <Skeleton height={120} />
            <Skeleton height={200} />
          </SkeletonGroup>
        )}
      </Screen>
    );
  }

  const settled = isSettled(s);
  const canRemindNow = remindable(s) > 0;

  return (
    <Screen
      header={<SendHeader title="Split bill" />}
      edges={['top', 'bottom']}
      footer={
        settled ? (
          <Button label="Done" onPress={() => router.dismissTo('/')} />
        ) : (
          <View style={{ gap: spacing[2] }}>
            {message && (
              <Text
                variant="bodySmall"
                color={message.ok ? 'success' : 'danger'}
                accessibilityLiveRegion="polite"
              >
                {message.text}
              </Text>
            )}
            <Button
              label="Remind those who haven't paid"
              icon={BellRing}
              variant="secondary"
              disabled={!canRemindNow}
              loading={remind.isPending}
              onPress={remindAll}
              accessibilityHint={
                canRemindNow ? undefined : 'Everyone still to pay was reminded in the last day'
              }
            />
          </View>
        )
      }
    >
      <Card>
        <View style={{ gap: spacing[3] }}>
          <View style={[styles.row, { gap: spacing[2] }]}>
            <View style={styles.flex}>
              <Text variant="title">{s.title}</Text>
              <Text color="textMuted">
                {formatMoney(fromApiMoney(s.total))} · {s.split === 'equal' ? 'equal' : 'custom'}{' '}
                shares
              </Text>
            </View>
            {settled && <Badge label="Settled" tone="success" />}
          </View>
          <SplitProgress split={s} />
        </View>
      </Card>

      <Card>
        <View style={{ gap: spacing[3] }}>
          {s.shares.map((share) => {
            const self = share.money_request_id === null;
            const status = REQUEST_STATUS[share.status];
            const amount = formatMoney(fromApiMoney(share.amount));
            const note = self
              ? 'Your share'
              : share.status === 'pending' && share.last_reminded_at
                ? remindedAgo(share.last_reminded_at)
                : share.participant.nemtag
                  ? `@${share.participant.nemtag}`
                  : '';
            return (
              <View
                key={share.money_request_id ?? 'self'}
                accessible
                accessibilityLabel={`${self ? 'You' : share.participant.name}, ${amount}, ${self ? 'paid' : status.label}`}
                style={[styles.row, { gap: spacing[3] }]}
              >
                <Avatar name={share.participant.name} size="sm" ring={!self} />
                <View style={styles.flex}>
                  <Text numberOfLines={1}>{self ? 'You' : share.participant.name}</Text>
                  <Text variant="caption" color="textMuted">
                    {note}
                  </Text>
                </View>
                <View style={styles.trailing}>
                  <Text variant="bodyStrong">{amount}</Text>
                  {!self && <Badge label={status.label} tone={status.tone} />}
                </View>
              </View>
            );
          })}
        </View>
      </Card>
      <Text variant="caption" color="textMuted">
        Each person got a money request for their share. It shows as paid the moment they pay.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  trailing: { alignItems: 'flex-end', gap: 4 },
  flex: { flex: 1 },
});
