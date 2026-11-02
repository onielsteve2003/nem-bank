import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { Pause, Play, XCircle } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Avatar, Badge, BottomSheet, Button, Card, Dialog, Text } from '@/components';
import { fromApiMoney } from '@/lib/money';
import { useRepoMutation } from '@/lib/query';
import { useTheme } from '@/theme';

import { FREQUENCIES, formatScheduleDay, isLive, lagosDayOf, STATUS_LABELS } from '../schedule';
import { useTranslation } from 'react-i18next';
import { localized } from '@/lib/i18n';

type ScheduledTransfer = Schema<'ScheduledTransfer'>;

const LAST_RUN_WORDS: Partial<Record<Schema<'TransferStatus'>, string>> = localized({
  completed: 'transfers.scheduled.lastRun.completed',
  processing: 'transfers.scheduled.lastRun.processing',
  failed: 'transfers.scheduled.lastRun.failed',
  reversed: 'transfers.scheduled.lastRun.reversed',
});

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.between}>
      <Text color="textMuted">{label}</Text>
      <Text variant="bodyStrong" style={styles.value}>
        {value}
      </Text>
    </View>
  );
}

interface Props {
  schedule: ScheduledTransfer;
  onClose: () => void;
}

/**
 * One scheduled or repeating payment (TRF-9): pause, resume or cancel it.
 * Mount it only while one is chosen.
 */
export function ScheduledSheet({ schedule, onClose }: Props) {
  const { spacing } = useTheme();
  const [s, setS] = useState(schedule);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState<string>();
  const { t } = useTranslation();
  const update = useRepoMutation('transfers', 'updateScheduled', { invalidates: [['transfers']] });
  const cancel = useRepoMutation('transfers', 'cancelScheduled', { invalidates: [['transfers']] });
  const status = STATUS_LABELS[s.status];
  const firstName = s.recipient.name.split(' ')[0];
  const lastRun = s.last_run
    ? t('transfers.scheduled.lastRunValue', {
        day: formatScheduleDay(lagosDayOf(s.last_run.at)),
        status: LAST_RUN_WORDS[s.last_run.status] ?? t('transfers.scheduled.lastRun.waiting'),
      })
    : t('transfers.scheduled.noneYet');

  const setStatus = (next: 'active' | 'paused') => {
    setError(undefined);
    update.mutate(
      { path: { schedule_id: s.id }, body: { status: next } },
      {
        onSuccess: setS,
        onError: () => setError(t('transfers.scheduled.changeFailed')),
      },
    );
  };

  const cancelIt = () =>
    cancel.mutate(
      { path: { schedule_id: s.id } },
      {
        onSuccess: () => {
          setConfirmCancel(false);
          onClose();
        },
        onError: () => {
          setConfirmCancel(false);
          setError(t('transfers.scheduled.cancelFailed'));
        },
      },
    );

  return (
    <BottomSheet open onClose={onClose} title={t('transfers.scheduled.title')}>
      <View style={{ gap: spacing[4] }}>
        <View style={[styles.row, { gap: spacing[3] }]}>
          <Avatar name={s.recipient.name} size="lg" ring={Boolean(s.recipient.nemtag)} />
          <View style={styles.flex}>
            <Text variant="bodyStrong">{s.recipient.name}</Text>
            <Text variant="bodySmall" color="textMuted">
              {s.recipient.nemtag
                ? t('transfers.scheduled.nemUser', { nemtag: s.recipient.nemtag })
                : `${s.recipient.bank_name} · ${s.recipient.account_number_masked}`}
            </Text>
          </View>
          <Badge label={status.label} tone={status.tone} />
        </View>

        <Card>
          <View style={{ gap: spacing[3] }}>
            <Row label={t('common.amount')} value={formatMoney(fromApiMoney(s.amount))} />
            <Row label={t('transfers.scheduled.howOften')} value={FREQUENCIES[s.frequency]} />
            <Row
              label={t('transfers.scheduled.next')}
              value={
                s.status === 'paused'
                  ? t('transfers.scheduled.paused')
                  : s.next_run_at
                    ? t('transfers.scheduled.nextValue', {
                        day: formatScheduleDay(lagosDayOf(s.next_run_at)),
                      })
                    : t('transfers.scheduled.none')
              }
            />
            {s.ends_on && (
              <Row label={t('transfers.scheduled.lastDay')} value={formatScheduleDay(s.ends_on)} />
            )}
            <Row label={t('transfers.scheduled.lastPayment')} value={lastRun} />
            <Row label={t('common.note')} value={s.narration} />
          </View>
        </Card>

        {isLive(s) && (
          <>
            {s.status === 'active' ? (
              <Button
                label={t('transfers.scheduled.pause')}
                icon={Pause}
                variant="secondary"
                loading={update.isPending}
                onPress={() => setStatus('paused')}
              />
            ) : (
              <Button
                label={t('transfers.scheduled.resume')}
                icon={Play}
                loading={update.isPending}
                onPress={() => setStatus('active')}
              />
            )}
            <Button
              label={t('transfers.scheduled.cancel')}
              icon={XCircle}
              variant="ghost"
              onPress={() => setConfirmCancel(true)}
            />
            <Text variant="caption" color="textMuted">
              {s.status === 'paused'
                ? t('transfers.scheduled.pausedNote')
                : t('transfers.scheduled.activeNote', { name: firstName })}
            </Text>
          </>
        )}

        {error && (
          <Text variant="bodySmall" color="danger" accessibilityLiveRegion="assertive">
            {error}
          </Text>
        )}
      </View>

      <Dialog
        open={confirmCancel}
        title={t('transfers.scheduled.cancelTitle')}
        message={t('transfers.scheduled.cancelMessage', { name: firstName })}
        confirmLabel={t('transfers.scheduled.cancel')}
        cancelLabel={t('common.keepIt')}
        destructive
        loading={cancel.isPending}
        onConfirm={cancelIt}
        onCancel={() => setConfirmCancel(false)}
      />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  between: { flexDirection: 'row', justifyContent: 'space-between', gap: 16 },
  value: { flexShrink: 1, textAlign: 'right' },
  flex: { flex: 1 },
});
