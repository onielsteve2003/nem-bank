import type { Schema } from '@nem/contracts';
import { Globe, Monitor, Smartphone } from '@/components/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  Badge,
  Button,
  Card,
  Dialog,
  Divider,
  ErrorState,
  ListItem,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
  useToast,
} from '@/components';
import { isApiError, type ApiError } from '@/data';
import i18n from '@/lib/i18n';
import { formatDateTime } from '@/features/transactions/format';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { deviceStatus, otherSessions } from '../security';

type Device = Schema<'Device'>;
type Session = Schema<'Session'>;
type Pending =
  { kind: 'device'; item: Device } | { kind: 'session'; item: Session } | { kind: 'all' } | null;

const PLATFORM_ICON = { ios: Smartphone, android: Smartphone, web: Globe } as const;

const message = (e: unknown) =>
  isApiError(e)
    ? e.problem.code === 'offline'
      ? i18n.t('common.offline')
      : (e.problem.detail ?? e.problem.title)
    : i18n.t('common.somethingWrong');

/**
 * Devices and sessions (SEC-2). Devices hold a signing key and can approve
 * payments; sessions are sign-ins. Removing a device also ends its sessions.
 * The current device and session can't be removed here (sign out instead).
 */
export function DevicesScreen() {
  const toast = useToast();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const devices = useRepoQuery('devices', 'list');
  const sessions = useRepoQuery('security', 'listSessions');
  const [pending, setPending] = useState<Pending>(null);
  const invalidates = [['devices'], ['security']];
  const onError = (e: ApiError) => toast.show({ message: message(e), tone: 'error' });
  const removeDevice = useRepoMutation('devices', 'revoke', { invalidates, onError });
  const endSession = useRepoMutation('security', 'revokeSession', { invalidates, onError });
  const others = otherSessions(sessions.data?.data ?? []);
  const platformOf = (deviceId: string) => {
    const device = devices.data?.data.find((d) => d.id === deviceId);
    return device ? PLATFORM_ICON[device.platform] : Monitor;
  };

  const confirm = async () => {
    if (!pending) return;
    try {
      if (pending.kind === 'device') {
        await removeDevice.mutateAsync({ path: { device_id: pending.item.id } });
        toast.show({
          message: t('security.devices.removed', { name: pending.item.name }),
          tone: 'success',
        });
      } else if (pending.kind === 'session') {
        await endSession.mutateAsync({ path: { session_id: pending.item.id } });
        toast.show({
          message: t('security.devices.signedOut', { name: pending.item.device_name }),
          tone: 'success',
        });
      } else {
        for (const s of others) await endSession.mutateAsync({ path: { session_id: s.id } });
        toast.show({ message: t('security.devices.signedOutAll'), tone: 'success' });
      }
    } catch {
      // onError already told the user.
    }
    setPending(null);
  };

  const failed = (devices.isError && !devices.data) || (sessions.isError && !sessions.data);
  let body;
  if (failed) {
    body = (
      <ErrorState
        title={t('security.devices.failed')}
        onRetry={() => {
          void devices.refetch();
          void sessions.refetch();
        }}
      />
    );
  } else if (!devices.data || !sessions.data) {
    body = (
      <SkeletonGroup accessibilityLabel={t('security.devices.loading')}>
        <Skeleton height={160} />
        <Skeleton height={160} />
      </SkeletonGroup>
    );
  } else {
    body = (
      <>
        <View style={{ gap: spacing[2] }}>
          <SectionHeader title={t('security.devices.devices')} />
          <Text variant="bodySmall" color="textMuted">
            {t('security.devices.intro')}
          </Text>
          <Card padded={false}>
            <View accessibilityRole="list">
              {devices.data.data.map((d, i) => {
                const status = deviceStatus(d);
                return (
                  <View key={d.id}>
                    {i > 0 && <Divider />}
                    <ListItem
                      title={d.name}
                      subtitle={t('security.devices.lastUsed', {
                        status: status.label,
                        when: formatDateTime(d.last_seen_at),
                      })}
                      leading={PLATFORM_ICON[d.platform]}
                      trailing={
                        d.current ? (
                          <Badge label={t('security.devices.thisDevice')} tone="primary" />
                        ) : (
                          <Button
                            label={t('common.remove')}
                            size="sm"
                            variant="secondary"
                            onPress={() => setPending({ kind: 'device', item: d })}
                            accessibilityHint={d.name}
                          />
                        )
                      }
                      accessibilityLabel={t(
                        d.current
                          ? 'security.devices.deviceLabelCurrent'
                          : 'security.devices.deviceLabel',
                        {
                          name: d.name,
                          status: status.label,
                          when: formatDateTime(d.last_seen_at),
                        },
                      )}
                    />
                  </View>
                );
              })}
            </View>
          </Card>
        </View>
        <View style={{ gap: spacing[2] }}>
          <SectionHeader title={t('security.devices.signedIn')} />
          <Card padded={false}>
            <View accessibilityRole="list">
              {sessions.data.data.map((s, i) => {
                const where = s.ip_location ? `${s.ip_location} · ` : '';
                const when = t('security.devices.active', {
                  when: formatDateTime(s.last_active_at),
                });
                return (
                  <View key={s.id}>
                    {i > 0 && <Divider />}
                    <ListItem
                      title={s.device_name}
                      subtitle={`${where}${when}`}
                      leading={platformOf(s.device_id)}
                      trailing={
                        s.current ? (
                          <Badge label={t('security.devices.youreHere')} tone="primary" />
                        ) : (
                          <Button
                            label={t('security.devices.signOut')}
                            size="sm"
                            variant="secondary"
                            onPress={() => setPending({ kind: 'session', item: s })}
                            accessibilityHint={s.device_name}
                          />
                        )
                      }
                      accessibilityLabel={t(
                        s.current
                          ? 'security.devices.sessionLabelCurrent'
                          : 'security.devices.sessionLabel',
                        { name: s.device_name, where, when },
                      )}
                    />
                  </View>
                );
              })}
            </View>
          </Card>
          {others.length > 1 && (
            <Button
              label={t('security.devices.signOutAll')}
              variant="secondary"
              onPress={() => setPending({ kind: 'all' })}
            />
          )}
        </View>
      </>
    );
  }

  const dialog =
    pending?.kind === 'device'
      ? {
          title: t('security.devices.removeTitle', { name: pending.item.name }),
          message: t('security.devices.removeMessage'),
          confirmLabel: t('security.devices.removeConfirm'),
        }
      : pending?.kind === 'session'
        ? {
            title: t('security.devices.signOutTitle', { name: pending.item.device_name }),
            message: t('security.devices.signOutMessage'),
            confirmLabel: t('security.devices.signOutConfirm'),
          }
        : {
            title: t('security.devices.signOutAllTitle'),
            message: t('security.devices.signOutAllMessage', { count: others.length }),
            confirmLabel: t('security.devices.signOutAllConfirm'),
          };

  return (
    <Screen
      header={<SendHeader title={t('security.devices.title')} />}
      edges={['top', 'bottom']}
      onRefresh={() => {
        void devices.refetch();
        void sessions.refetch();
      }}
      refreshing={devices.isRefetching || sessions.isRefetching}
    >
      {body}
      <Dialog
        open={pending !== null}
        {...dialog}
        destructive
        loading={removeDevice.isPending || endSession.isPending}
        onConfirm={() => void confirm()}
        onCancel={() => setPending(null)}
      />
    </Screen>
  );
}
