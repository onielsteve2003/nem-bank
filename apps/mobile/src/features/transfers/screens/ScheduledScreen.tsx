import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CalendarClock, CircleCheck } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Avatar,
  Button,
  Card,
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
import { fromApiMoney } from '@/lib/money';
import { useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { ScheduledSheet } from '../components/ScheduledSheet';
import { SendHeader } from '../components/SendHeader';
import {
  formatScheduleDay,
  isLive,
  lagosDayOf,
  scheduleSubtitle,
  sortSchedules,
} from '../schedule';

type ScheduledTransfer = Schema<'ScheduledTransfer'>;

function ScheduleRow({
  schedule,
  onPress,
}: {
  schedule: ScheduledTransfer;
  onPress: (s: ScheduledTransfer) => void;
}) {
  const amount = formatMoney(fromApiMoney(schedule.amount));
  const subtitle = scheduleSubtitle(schedule);
  return (
    <ListItem
      leading={
        <Avatar
          name={schedule.recipient.name}
          size="md"
          ring={Boolean(schedule.recipient.nemtag)}
        />
      }
      title={schedule.recipient.name}
      subtitle={subtitle}
      trailing={
        <Text variant="bodyStrong" color={isLive(schedule) ? 'text' : 'textMuted'}>
          {amount}
        </Text>
      }
      onPress={() => onPress(schedule)}
      accessibilityLabel={`${schedule.recipient.name}, ${amount}, ${subtitle}`}
      accessibilityHint="Pause, resume or cancel"
    />
  );
}

/**
 * Scheduled and repeating payments (TRF-9): what goes next and when, with
 * pause, resume and cancel. Opened after scheduling one (`?created=`), from
 * the send hub and from the Pay tab.
 */
export function ScheduledScreen() {
  const router = useRouter();
  const { created } = useLocalSearchParams<{ created?: string }>();
  const { spacing } = useTheme();
  const [chosen, setChosen] = useState<ScheduledTransfer | null>(null);
  const schedules = useRepoQuery('transfers', 'listScheduled', { query: { limit: 100 } });

  const list = schedules.data ? sortSchedules(schedules.data.data) : undefined;
  const live = list?.filter(isLive) ?? [];
  const ended = list?.filter((s) => !isLive(s)) ?? [];
  const justMade = created ? list?.find((s) => s.id === created) : undefined;

  return (
    <Screen
      header={<SendHeader title="Scheduled payments" />}
      edges={['top', 'bottom']}
      footer={
        // Straight after scheduling, Back would land on the old amount screen.
        created ? <Button label="Done" onPress={() => router.dismissTo('/')} /> : undefined
      }
    >
      {justMade?.next_run_at && (
        <Card>
          <View style={[styles.row, { gap: spacing[3] }]}>
            <Icon icon={CircleCheck} color="success" />
            <Text style={styles.flex} accessibilityLiveRegion="polite">
              Scheduled. The first payment to {justMade.recipient.name.split(' ')[0]} goes on{' '}
              {formatScheduleDay(lagosDayOf(justMade.next_run_at))} at about 9 am.
            </Text>
          </View>
        </Card>
      )}

      {list ? (
        list.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            title="Nothing scheduled"
            message="Set a payment to go on a later day, or every day, week or month. Tap “Send now” on the review screen to choose."
            actionLabel="Schedule a payment"
            onAction={() => router.replace('/send')}
          />
        ) : (
          <>
            {live.length > 0 && (
              <Card padded={false}>
                {live.map((s) => (
                  <ScheduleRow key={s.id} schedule={s} onPress={setChosen} />
                ))}
              </Card>
            )}
            {ended.length > 0 && (
              <>
                <SectionHeader title="Ended" />
                <Card padded={false}>
                  {ended.map((s) => (
                    <ScheduleRow key={s.id} schedule={s} onPress={setChosen} />
                  ))}
                </Card>
              </>
            )}
            <Text variant="caption" color="textMuted">
              Payments go at about 9 am Lagos time. Each one is checked and priced when it goes.
            </Text>
          </>
        )
      ) : schedules.isError ? (
        <ErrorState
          title="We couldn't load your scheduled payments"
          onRetry={() => schedules.refetch()}
        />
      ) : (
        <SkeletonGroup accessibilityLabel="Loading scheduled payments">
          <View style={{ gap: spacing[2] }}>
            <SkeletonListItem />
            <SkeletonListItem />
          </View>
        </SkeletonGroup>
      )}

      {chosen && (
        <ScheduledSheet key={chosen.id} schedule={chosen} onClose={() => setChosen(null)} />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
