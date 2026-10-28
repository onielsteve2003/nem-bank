import type { Schema } from '@nem/contracts';
import { equals, money } from '@nem/shared';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Card,
  Chip,
  Dialog,
  Divider,
  ErrorState,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Switch,
  Text,
  useToast,
} from '@/components';
import { isApiError } from '@/data';
import { formatDateTime } from '@/features/transactions/format';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { fromApiMoney, toApiMoney } from '@/lib/money';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { ALERT_THRESHOLDS, alertThresholdLabel, coolingOffDevice } from '../security';

type Prefs = Schema<'AlertPreferences'>;
type SignInAlert = 'login_alerts' | 'new_device_alerts';

const TURN_OFF: Record<SignInAlert, { title: string; message: string }> = {
  login_alerts: {
    title: 'Turn off login alerts?',
    message: "You won't hear from us when someone logs in to your account, even if it isn't you.",
  },
  new_device_alerts: {
    title: 'Turn off new device alerts?',
    message: "You won't hear from us when a new phone or browser is added to your account.",
  },
};

const message = (e: unknown) =>
  isApiError(e)
    ? e.problem.code === 'offline'
      ? "You're offline. Reconnect and try again."
      : (e.problem.detail ?? e.problem.title)
    : "We couldn't save that. Try again.";

/**
 * Login and payment alerts (SEC-7). Each change saves at once. Turning a
 * sign-in alert off is confirmed first; new-device alerts can't be turned off
 * while a device is in its cool-off.
 */
export function AlertsScreen() {
  const toast = useToast();
  const { spacing } = useTheme();
  const q = useRepoQuery('security', 'getAlerts');
  const devices = useRepoQuery('devices', 'list');
  const save = useRepoMutation('security', 'setAlerts');
  /** What the customer last chose, shown while it saves and after. */
  const [chosen, setChosen] = useState<Prefs>();
  const [turningOff, setTurningOff] = useState<SignInAlert | null>(null);
  const prefs = chosen ?? q.data;
  const cooling = coolingOffDevice(devices.data?.data ?? []);

  const update = (patch: Partial<Prefs>) => {
    if (!prefs) return;
    const next = { ...prefs, ...patch };
    setChosen(next);
    save.mutate(
      { body: next },
      {
        onSuccess: (saved) => setChosen(saved),
        onError: (e) => {
          setChosen(undefined);
          toast.show({ message: message(e), tone: 'error' });
        },
      },
    );
  };

  const toggle = (key: SignInAlert, on: boolean) =>
    on ? update({ [key]: true }) : setTurningOff(key);

  let body;
  if (q.isError && !prefs) {
    body = <ErrorState title="We couldn't load your alerts" onRetry={() => q.refetch()} />;
  } else if (!prefs) {
    body = (
      <SkeletonGroup accessibilityLabel="Loading your alerts">
        <Skeleton height={150} />
        <Skeleton height={120} />
      </SkeletonGroup>
    );
  } else {
    const threshold = fromApiMoney(prefs.transaction_alert_threshold);
    const presets = ALERT_THRESHOLDS.map((n) => money(BigInt(n) * 100n, 'NGN'));
    const options = presets.some((p) => equals(p, threshold)) ? presets : [...presets, threshold];
    body = (
      <>
        <View style={{ gap: spacing[2] }}>
          <SectionHeader title="Sign-ins" />
          <Card>
            <Switch
              label="Login alerts"
              description="Every time someone logs in to your account"
              value={prefs.login_alerts}
              onValueChange={(on) => toggle('login_alerts', on)}
            />
            <Divider />
            <Switch
              label="New device alerts"
              description={
                cooling
                  ? `Stays on while ${cooling.name} is new to your account, until ${formatDateTime(cooling.cool_off_until!)}`
                  : 'When a new phone or browser is added'
              }
              value={prefs.new_device_alerts || Boolean(cooling)}
              disabled={Boolean(cooling)}
              onValueChange={(on) => toggle('new_device_alerts', on)}
            />
          </Card>
          <Text variant="bodySmall" color="textMuted">
            Keeping both on counts towards your security score.
          </Text>
        </View>
        <View style={{ gap: spacing[2] }}>
          <SectionHeader title="Payments" />
          <Card>
            <View style={{ gap: spacing[3] }}>
              <Text variant="bodyStrong">Alert me when money leaves for</Text>
              <View style={[styles.chips, { gap: spacing[2] }]}>
                {options.map((m) => (
                  <Chip
                    key={m.amount.toString()}
                    label={alertThresholdLabel(m)}
                    selected={equals(m, threshold)}
                    onPress={() => update({ transaction_alert_threshold: toApiMoney(m) })}
                  />
                ))}
              </View>
              <Text variant="bodySmall" color="textMuted">
                {threshold.amount === 0n
                  ? 'You get an alert for every payment, card payment and bill.'
                  : `Smaller payments still show in your activity, just without an alert.`}
              </Text>
            </View>
          </Card>
        </View>
      </>
    );
  }

  const asking = turningOff ? TURN_OFF[turningOff] : null;
  return (
    <Screen
      header={<SendHeader title="Login and payment alerts" />}
      edges={['top', 'bottom']}
      onRefresh={() => {
        setChosen(undefined);
        void q.refetch();
      }}
      refreshing={q.isRefetching}
    >
      {body}
      <Dialog
        open={asking !== null}
        title={asking?.title ?? ''}
        message={asking?.message ?? ''}
        confirmLabel="Turn off"
        destructive
        onConfirm={() => {
          if (turningOff) update({ [turningOff]: false });
          setTurningOff(null);
        }}
        onCancel={() => setTurningOff(null)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
});
