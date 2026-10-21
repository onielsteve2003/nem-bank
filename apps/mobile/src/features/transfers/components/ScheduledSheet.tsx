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

type ScheduledTransfer = Schema<'ScheduledTransfer'>;

const LAST_RUN_WORDS: Partial<Record<Schema<'TransferStatus'>, string>> = {
  completed: 'sent',
  processing: 'on its way',
  failed: 'not sent',
  reversed: 'returned',
};

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
  const update = useRepoMutation('transfers', 'updateScheduled', { invalidates: [['transfers']] });
  const cancel = useRepoMutation('transfers', 'cancelScheduled', { invalidates: [['transfers']] });
  const status = STATUS_LABELS[s.status];
  const firstName = s.recipient.name.split(' ')[0];
  const lastRun = s.last_run
    ? `${formatScheduleDay(lagosDayOf(s.last_run.at))}, ${LAST_RUN_WORDS[s.last_run.status] ?? 'waiting'}`
    : 'None yet';

  const setStatus = (next: 'active' | 'paused') => {
    setError(undefined);
    update.mutate(
      { path: { schedule_id: s.id }, body: { status: next } },
      {
        onSuccess: setS,
        onError: () => setError("We couldn't change it. Try again."),
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
          setError("We couldn't cancel it. Try again.");
        },
      },
    );

  return (
    <BottomSheet open onClose={onClose} title="Scheduled payment">
      <View style={{ gap: spacing[4] }}>
        <View style={[styles.row, { gap: spacing[3] }]}>
          <Avatar name={s.recipient.name} size="lg" ring={Boolean(s.recipient.nemtag)} />
          <View style={styles.flex}>
            <Text variant="bodyStrong">{s.recipient.name}</Text>
            <Text variant="bodySmall" color="textMuted">
              {s.recipient.nemtag
                ? `@${s.recipient.nemtag} · Nem user`
                : `${s.recipient.bank_name} · ${s.recipient.account_number_masked}`}
            </Text>
          </View>
          <Badge label={status.label} tone={status.tone} />
        </View>

        <Card>
          <View style={{ gap: spacing[3] }}>
            <Row label="Amount" value={formatMoney(fromApiMoney(s.amount))} />
            <Row label="How often" value={FREQUENCIES[s.frequency]} />
            <Row
              label="Next payment"
              value={
                s.status === 'paused'
                  ? 'Paused'
                  : s.next_run_at
                    ? `${formatScheduleDay(lagosDayOf(s.next_run_at))}, about 9 am`
                    : 'None'
              }
            />
            {s.ends_on && <Row label="Last day" value={formatScheduleDay(s.ends_on)} />}
            <Row label="Last payment" value={lastRun} />
            <Row label="Note" value={s.narration} />
          </View>
        </Card>

        {isLive(s) && (
          <>
            {s.status === 'active' ? (
              <Button
                label="Pause"
                icon={Pause}
                variant="secondary"
                loading={update.isPending}
                onPress={() => setStatus('paused')}
              />
            ) : (
              <Button
                label="Resume"
                icon={Play}
                loading={update.isPending}
                onPress={() => setStatus('active')}
              />
            )}
            <Button
              label="Cancel schedule"
              icon={XCircle}
              variant="ghost"
              onPress={() => setConfirmCancel(true)}
            />
            <Text variant="caption" color="textMuted">
              {s.status === 'paused'
                ? 'Paused payments are skipped, not saved up. Resuming starts again from the next due day.'
                : `Each payment to ${firstName} is checked and priced when it goes. If there isn't enough money, that one is skipped and we tell you.`}
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
        title="Cancel this schedule?"
        message={`No more payments will go to ${firstName}. Payments already sent stay in your history.`}
        confirmLabel="Cancel schedule"
        cancelLabel="Keep it"
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
