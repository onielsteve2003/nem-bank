import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CalendarClock, CircleCheck } from '@/components/icons';
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
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
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
      accessibilityHint={t('transfers.scheduledScreen.hint')}
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
  const { t } = useTranslation();
  const schedules = useRepoQuery('transfers', 'listScheduled', { query: { limit: 100 } });

  const list = schedules.data ? sortSchedules(schedules.data.data) : undefined;
  const live = list?.filter(isLive) ?? [];
  const ended = list?.filter((s) => !isLive(s)) ?? [];
  const justMade = created ? list?.find((s) => s.id === created) : undefined;

  return (
    <Screen
      header={<SendHeader title={t('transfers.scheduledScreen.title')} />}
      edges={['top', 'bottom']}
      footer={
        // Straight after scheduling, Back would land on the old amount screen.
        created ? (
          <Button label={t('common.done')} onPress={() => router.dismissTo('/')} />
        ) : undefined
      }
    >
      {justMade?.next_run_at && (
        <Card>
          <View style={[styles.row, { gap: spacing[3] }]}>
            <Icon icon={CircleCheck} color="success" />
            <Text style={styles.flex} accessibilityLiveRegion="polite">
              {t('transfers.scheduledScreen.made', {
                name: justMade.recipient.name.split(' ')[0],
                day: formatScheduleDay(lagosDayOf(justMade.next_run_at)),
              })}
            </Text>
          </View>
        </Card>
      )}

      {list ? (
        list.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            title={t('transfers.scheduledScreen.none')}
            message={t('transfers.scheduledScreen.noneMessage')}
            actionLabel={t('transfers.scheduledScreen.schedule')}
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
                <SectionHeader title={t('transfers.scheduledScreen.ended')} />
                <Card padded={false}>
                  {ended.map((s) => (
                    <ScheduleRow key={s.id} schedule={s} onPress={setChosen} />
                  ))}
                </Card>
              </>
            )}
            <Text variant="caption" color="textMuted">
              {t('transfers.scheduledScreen.note')}
            </Text>
          </>
        )
      ) : schedules.isError ? (
        <ErrorState
          title={t('transfers.scheduledScreen.failed')}
          onRetry={() => schedules.refetch()}
        />
      ) : (
        <SkeletonGroup accessibilityLabel={t('transfers.scheduledScreen.loading')}>
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
