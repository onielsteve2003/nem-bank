import type { Schema } from '@nem/contracts';
import { equals, money } from '@nem/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import i18n from '@/lib/i18n';
import { formatDateTime } from '@/features/transactions/format';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { fromApiMoney, toApiMoney } from '@/lib/money';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { ALERT_THRESHOLDS, alertThresholdLabel, coolingOffDevice } from '../security';

type Prefs = Schema<'AlertPreferences'>;
type SignInAlert = 'login_alerts' | 'new_device_alerts';

const TURN_OFF = {
  login_alerts: {
    title: 'security.alerts.loginOffTitle',
    message: 'security.alerts.loginOffMessage',
  },
  new_device_alerts: {
    title: 'security.alerts.deviceOffTitle',
    message: 'security.alerts.deviceOffMessage',
  },
} as const satisfies Record<SignInAlert, { title: string; message: string }>;

const message = (e: unknown) =>
  isApiError(e)
    ? e.problem.code === 'offline'
      ? i18n.t('common.offline')
      : (e.problem.detail ?? e.problem.title)
    : i18n.t('common.saveFailedGeneric');

/**
 * Login and payment alerts (SEC-7). Each change saves at once. Turning a
 * sign-in alert off is confirmed first; new-device alerts can't be turned off
 * while a device is in its cool-off.
 */
export function AlertsScreen() {
  const toast = useToast();
  const { spacing } = useTheme();
  const { t } = useTranslation();
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
    body = <ErrorState title={t('security.alerts.failed')} onRetry={() => q.refetch()} />;
  } else if (!prefs) {
    body = (
      <SkeletonGroup accessibilityLabel={t('security.alerts.loading')}>
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
          <SectionHeader title={t('security.alerts.signIns')} />
          <Card>
            <Switch
              label={t('security.alerts.login')}
              description={t('security.alerts.loginHelp')}
              value={prefs.login_alerts}
              onValueChange={(on) => toggle('login_alerts', on)}
            />
            <Divider />
            <Switch
              label={t('security.alerts.newDevice')}
              description={
                cooling
                  ? t('security.alerts.coolingOff', {
                      name: cooling.name,
                      until: formatDateTime(cooling.cool_off_until!),
                    })
                  : t('security.alerts.newDeviceHelp')
              }
              value={prefs.new_device_alerts || Boolean(cooling)}
              disabled={Boolean(cooling)}
              onValueChange={(on) => toggle('new_device_alerts', on)}
            />
          </Card>
          <Text variant="bodySmall" color="textMuted">
            {t('security.alerts.scoreNote')}
          </Text>
        </View>
        <View style={{ gap: spacing[2] }}>
          <SectionHeader title={t('security.alerts.payments')} />
          <Card>
            <View style={{ gap: spacing[3] }}>
              <Text variant="bodyStrong">{t('security.alerts.leavesFor')}</Text>
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
                  ? t('security.alerts.every')
                  : t('security.alerts.smaller')}
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
      header={<SendHeader title={t('security.alerts.title')} />}
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
        title={asking ? t(asking.title) : ''}
        message={asking ? t(asking.message) : ''}
        confirmLabel={t('common.turnOff')}
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
