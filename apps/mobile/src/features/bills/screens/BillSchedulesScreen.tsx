import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CalendarClock, CircleCheck } from '@/components/icons';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  Icon,
  ListItem,
  Screen,
  SectionHeader,
  SkeletonGroup,
  SkeletonListItem,
  Text,
} from '@/components';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import {
  FREQUENCIES,
  formatScheduleDay,
  lagosDayOf,
  STATUS_LABELS,
} from '@/features/transfers/schedule';
import { fromApiMoney } from '@/lib/money';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { isLiveSchedule, sortBillSchedules } from '../bills';
import { useTranslation } from 'react-i18next';
import i18n from '@/lib/i18n';

type BillSchedule = Schema<'BillSchedule'>;

/** "Every month · next Sat, 1 Nov", or how it ended. */
function subtitleOf(s: BillSchedule) {
  const every = FREQUENCIES[s.frequency];
  if (s.status === 'active' && s.next_run_at) {
    return i18n.t('bills.schedules.next', {
      customer: s.customer_id,
      every,
      day: formatScheduleDay(lagosDayOf(s.next_run_at)),
    });
  }
  return i18n.t('bills.schedules.ended', {
    customer: s.customer_id,
    every,
    status: STATUS_LABELS[s.status].label.toLowerCase(),
  });
}

/**
 * Scheduled bills (BILL-3): what is paid next and when, with cancel. Opened
 * from the bills hub and after scheduling one (`?created=`).
 */
export function BillSchedulesScreen() {
  const router = useRouter();
  const { created } = useLocalSearchParams<{ created?: string }>();
  const { spacing } = useTheme();
  const [cancelling, setCancelling] = useState<BillSchedule | null>(null);
  const [error, setError] = useState<string>();
  const { t } = useTranslation();
  const schedules = useRepoQuery('bills', 'listSchedules');
  const cancel = useRepoMutation('bills', 'cancelSchedule', { invalidates: [['bills']] });

  const list = schedules.data ? sortBillSchedules(schedules.data.data) : undefined;
  const live = list?.filter(isLiveSchedule) ?? [];
  const ended = list?.filter((s) => !isLiveSchedule(s)) ?? [];
  const justMade = created ? list?.find((s) => s.id === created) : undefined;

  const row = (s: BillSchedule) => {
    const amount = formatMoney(fromApiMoney(s.amount));
    const subtitle = subtitleOf(s);
    const canCancel = isLiveSchedule(s);
    return (
      <ListItem
        key={s.id}
        leading={CalendarClock}
        title={s.biller_name}
        subtitle={subtitle}
        trailing={
          <View style={styles.end}>
            <Text variant="bodyStrong" color={canCancel ? 'text' : 'textMuted'}>
              {amount}
            </Text>
            {!canCancel && (
              <Badge label={STATUS_LABELS[s.status].label} tone={STATUS_LABELS[s.status].tone} />
            )}
          </View>
        }
        onPress={canCancel ? () => setCancelling(s) : undefined}
        accessibilityLabel={`${s.biller_name}, ${amount}, ${subtitle}`}
        accessibilityHint={canCancel ? t('bills.schedules.cancelHint') : undefined}
      />
    );
  };

  return (
    <Screen
      header={<SendHeader title={t('bills.hub.scheduled')} />}
      edges={['top', 'bottom']}
      footer={
        // Straight after scheduling, Back would land on the old purchase screen.
        created ? (
          <Button label={t('common.done')} onPress={() => router.dismissTo('/bills')} />
        ) : undefined
      }
      onRefresh={() => void schedules.refetch()}
      refreshing={schedules.isRefetching}
    >
      {justMade?.next_run_at && (
        <Card>
          <View style={[styles.row, { gap: spacing[3] }]}>
            <Icon icon={CircleCheck} color="success" />
            <Text style={styles.flex} accessibilityLiveRegion="polite">
              {t('bills.schedules.made', {
                biller: justMade.biller_name,
                day: formatScheduleDay(lagosDayOf(justMade.next_run_at)),
              })}
            </Text>
          </View>
        </Card>
      )}
      {error && (
        <Text variant="bodySmall" color="danger" accessibilityRole="alert">
          {error}
        </Text>
      )}

      {list ? (
        list.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            title={t('bills.schedules.none')}
            message={t('bills.schedules.noneMessage')}
            actionLabel={t('bills.schedules.payBill')}
            onAction={() => router.dismissTo('/bills')}
          />
        ) : (
          <>
            {live.length > 0 && <Card padded={false}>{live.map(row)}</Card>}
            {ended.length > 0 && (
              <>
                <SectionHeader title={t('bills.schedules.endedTitle')} />
                <Card padded={false}>{ended.map(row)}</Card>
              </>
            )}
            <Text variant="caption" color="textMuted">
              {t('bills.schedules.note')}
            </Text>
          </>
        )
      ) : schedules.isError ? (
        <ErrorState title={t('bills.schedules.failed')} onRetry={() => schedules.refetch()} />
      ) : (
        <SkeletonGroup accessibilityLabel={t('bills.schedules.loading')}>
          <View style={{ gap: spacing[2] }}>
            <SkeletonListItem />
            <SkeletonListItem />
          </View>
        </SkeletonGroup>
      )}

      <Dialog
        open={cancelling !== null}
        title={t('bills.schedules.cancelTitle')}
        message={
          cancelling
            ? t('bills.schedules.cancelMessage', {
                biller: cancelling.biller_name,
                customer: cancelling.customer_id,
              })
            : undefined
        }
        confirmLabel={t('bills.schedules.cancel')}
        cancelLabel={t('bills.schedules.keep')}
        destructive
        loading={cancel.isPending}
        onCancel={() => setCancelling(null)}
        onConfirm={() => {
          if (!cancelling) return;
          setError(undefined);
          cancel.mutate(
            { path: { schedule_id: cancelling.id } },
            {
              onSettled: () => setCancelling(null),
              onError: () => setError(t('bills.schedules.cancelFailed')),
            },
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  end: { alignItems: 'flex-end', gap: 4 },
});
