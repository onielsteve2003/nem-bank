import { formatMoney } from '@nem/shared';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { BellRing, Receipt } from '@/components/icons';
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
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
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
            text: t('transfers.splitBill.reminded', { count }),
            ok: true,
          }),
        onError: (e) =>
          setMessage({
            text: isApiError(e, 'rate_limited')
              ? t('transfers.splitBill.allReminded')
              : requestErrorMessage(e),
            ok: false,
          }),
      },
    );
  };

  if (!s) {
    return (
      <Screen
        header={<SendHeader title={t('transfers.splitBill.title')} />}
        edges={['top', 'bottom']}
      >
        {split.isError ? (
          isApiError(split.error, 'not_found') ? (
            <EmptyState
              icon={Receipt}
              title={t('transfers.splitBill.notFound')}
              message={t('transfers.splitBill.notFoundMessage')}
              actionLabel={t('transfers.splitBill.seeAll')}
              onAction={() => router.replace('/send/splits')}
            />
          ) : (
            <ErrorState title={t('transfers.splitBill.failed')} onRetry={() => split.refetch()} />
          )
        ) : (
          <SkeletonGroup accessibilityLabel={t('transfers.splitBill.loading')}>
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
      header={<SendHeader title={t('transfers.splitBill.title')} />}
      edges={['top', 'bottom']}
      footer={
        settled ? (
          <Button label={t('common.done')} onPress={() => router.dismissTo('/')} />
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
              label={t('transfers.splitBill.remind')}
              icon={BellRing}
              variant="secondary"
              disabled={!canRemindNow}
              loading={remind.isPending}
              onPress={remindAll}
              accessibilityHint={canRemindNow ? undefined : t('transfers.splitBill.allReminded')}
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
                {t(
                  s.split === 'equal' ? 'transfers.splitBill.equal' : 'transfers.splitBill.custom',
                  {
                    amount: formatMoney(fromApiMoney(s.total)),
                  },
                )}
              </Text>
            </View>
            {settled && <Badge label={t('transfers.splitBill.settled')} tone="success" />}
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
              ? t('transfers.splitBill.yourShare')
              : share.status === 'pending' && share.last_reminded_at
                ? remindedAgo(share.last_reminded_at)
                : share.participant.nemtag
                  ? `@${share.participant.nemtag}`
                  : '';
            return (
              <View
                key={share.money_request_id ?? 'self'}
                accessible
                accessibilityLabel={t('transfers.splitBill.spoken', {
                  name: self ? t('common.you') : share.participant.name,
                  amount,
                  status: self ? t('transfers.splitBill.paid') : status.label,
                })}
                style={[styles.row, { gap: spacing[3] }]}
              >
                <Avatar name={share.participant.name} size="sm" ring={!self} />
                <View style={styles.flex}>
                  <Text numberOfLines={1}>{self ? t('common.you') : share.participant.name}</Text>
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
        {t('transfers.splitBill.note')}
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  trailing: { alignItems: 'flex-end', gap: 4 },
  flex: { flex: 1 },
});
