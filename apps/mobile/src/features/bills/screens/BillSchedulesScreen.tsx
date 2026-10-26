import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CalendarClock, CircleCheck } from 'lucide-react-native';
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

type BillSchedule = Schema<'BillSchedule'>;

/** "Every month · next Sat, 1 Nov", or how it ended. */
function subtitleOf(s: BillSchedule) {
  const every = FREQUENCIES[s.frequency];
  if (s.status === 'active' && s.next_run_at) {
    return `${s.customer_id} · ${every} · next ${formatScheduleDay(lagosDayOf(s.next_run_at))}`;
  }
  return `${s.customer_id} · ${every} · ${STATUS_LABELS[s.status].label.toLowerCase()}`;
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
        accessibilityHint={canCancel ? 'Cancel this schedule' : undefined}
      />
    );
  };

  return (
    <Screen
      header={<SendHeader title="Scheduled bills" />}
      edges={['top', 'bottom']}
      footer={
        // Straight after scheduling, Back would land on the old purchase screen.
        created ? <Button label="Done" onPress={() => router.dismissTo('/bills')} /> : undefined
      }
      onRefresh={() => void schedules.refetch()}
      refreshing={schedules.isRefetching}
    >
      {justMade?.next_run_at && (
        <Card>
          <View style={[styles.row, { gap: spacing[3] }]}>
            <Icon icon={CircleCheck} color="success" />
            <Text style={styles.flex} accessibilityLiveRegion="polite">
              Scheduled. {justMade.biller_name} is paid on{' '}
              {formatScheduleDay(lagosDayOf(justMade.next_run_at))} at about 9 am.
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
            title="No scheduled bills"
            message="Pay a bill on a later day, or every day, week or month. Tap “Pay now” before paying to choose."
            actionLabel="Pay a bill"
            onAction={() => router.dismissTo('/bills')}
          />
        ) : (
          <>
            {live.length > 0 && <Card padded={false}>{live.map(row)}</Card>}
            {ended.length > 0 && (
              <>
                <SectionHeader title="Ended" />
                <Card padded={false}>{ended.map(row)}</Card>
              </>
            )}
            <Text variant="caption" color="textMuted">
              Bills are paid at about 9 am Lagos time from your naira account. If it is short that
              day, the payment is skipped and we tell you.
            </Text>
          </>
        )
      ) : schedules.isError ? (
        <ErrorState
          title="We couldn't load your scheduled bills"
          onRetry={() => schedules.refetch()}
        />
      ) : (
        <SkeletonGroup accessibilityLabel="Loading scheduled bills">
          <View style={{ gap: spacing[2] }}>
            <SkeletonListItem />
            <SkeletonListItem />
          </View>
        </SkeletonGroup>
      )}

      <Dialog
        open={cancelling !== null}
        title="Cancel this schedule?"
        message={
          cancelling
            ? `${cancelling.biller_name} for ${cancelling.customer_id} won't be paid again. Payments already made stay as they are.`
            : undefined
        }
        confirmLabel="Cancel schedule"
        cancelLabel="Keep it"
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
              onError: () => setError("We couldn't cancel it. Try again."),
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
