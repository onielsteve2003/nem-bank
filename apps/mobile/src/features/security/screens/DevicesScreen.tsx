import type { Schema } from '@nem/contracts';
import { Globe, Monitor, Smartphone } from 'lucide-react-native';
import { useState } from 'react';
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
import { formatDateTime } from '@/features/transactions/format';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { deviceStatus, otherSessions } from '../security';

type Device = Schema<'Device'>;
type Session = Schema<'Session'>;
type Pending =
  | { kind: 'device'; item: Device }
  | { kind: 'session'; item: Session }
  | { kind: 'all' }
  | null;

const PLATFORM_ICON = { ios: Smartphone, android: Smartphone, web: Globe } as const;

const message = (e: unknown) =>
  isApiError(e)
    ? e.problem.code === 'offline'
      ? "You're offline. Reconnect and try again."
      : (e.problem.detail ?? e.problem.title)
    : 'Something went wrong. Try again.';

/**
 * Devices and sessions (SEC-2). Devices hold a signing key and can approve
 * payments; sessions are sign-ins. Removing a device also ends its sessions.
 * The current device and session can't be removed here (sign out instead).
 */
export function DevicesScreen() {
  const toast = useToast();
  const { spacing } = useTheme();
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
        toast.show({ message: `${pending.item.name} removed`, tone: 'success' });
      } else if (pending.kind === 'session') {
        await endSession.mutateAsync({ path: { session_id: pending.item.id } });
        toast.show({ message: `Signed out ${pending.item.device_name}`, tone: 'success' });
      } else {
        for (const s of others) await endSession.mutateAsync({ path: { session_id: s.id } });
        toast.show({ message: 'Signed out everywhere else', tone: 'success' });
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
        title="We couldn't load your devices"
        onRetry={() => {
          void devices.refetch();
          void sessions.refetch();
        }}
      />
    );
  } else if (!devices.data || !sessions.data) {
    body = (
      <SkeletonGroup accessibilityLabel="Loading your devices">
        <Skeleton height={160} />
        <Skeleton height={160} />
      </SkeletonGroup>
    );
  } else {
    body = (
      <>
        <View style={{ gap: spacing[2] }}>
          <SectionHeader title="Devices" />
          <Text variant="bodySmall" color="textMuted">
            These can approve payments with their own key. Remove any you don’t recognise.
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
                      subtitle={`${status.label} · last used ${formatDateTime(d.last_seen_at)}`}
                      leading={PLATFORM_ICON[d.platform]}
                      trailing={
                        d.current ? (
                          <Badge label="This device" tone="primary" />
                        ) : (
                          <Button
                            label="Remove"
                            size="sm"
                            variant="secondary"
                            onPress={() => setPending({ kind: 'device', item: d })}
                            accessibilityHint={d.name}
                          />
                        )
                      }
                      accessibilityLabel={`${d.name}. ${status.label}. Last used ${formatDateTime(d.last_seen_at)}.${d.current ? ' This device.' : ''}`}
                    />
                  </View>
                );
              })}
            </View>
          </Card>
        </View>
        <View style={{ gap: spacing[2] }}>
          <SectionHeader title="Signed in" />
          <Card padded={false}>
            <View accessibilityRole="list">
              {sessions.data.data.map((s, i) => {
                const where = s.ip_location ? `${s.ip_location} · ` : '';
                const when = `active ${formatDateTime(s.last_active_at)}`;
                return (
                  <View key={s.id}>
                    {i > 0 && <Divider />}
                    <ListItem
                      title={s.device_name}
                      subtitle={`${where}${when}`}
                      leading={platformOf(s.device_id)}
                      trailing={
                        s.current ? (
                          <Badge label="You’re here" tone="primary" />
                        ) : (
                          <Button
                            label="Sign out"
                            size="sm"
                            variant="secondary"
                            onPress={() => setPending({ kind: 'session', item: s })}
                            accessibilityHint={s.device_name}
                          />
                        )
                      }
                      accessibilityLabel={`${s.device_name}. ${where}${when}.${s.current ? ' This session.' : ''}`}
                    />
                  </View>
                );
              })}
            </View>
          </Card>
          {others.length > 1 && (
            <Button
              label="Sign out everywhere else"
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
          title: `Remove ${pending.item.name}?`,
          message:
            'It will be signed out and can no longer approve payments. Signing in on it again counts as a new device, with lower limits for 24 hours.',
          confirmLabel: 'Remove device',
        }
      : pending?.kind === 'session'
        ? {
            title: `Sign out ${pending.item.device_name}?`,
            message: 'That sign-in ends now. The device stays trusted for next time.',
            confirmLabel: 'Sign out now',
          }
        : {
            title: 'Sign out everywhere else?',
            message: `This ends ${others.length} other sign-ins. You stay signed in here.`,
            confirmLabel: 'Sign out all',
          };

  return (
    <Screen
      header={<SendHeader title="Devices and sessions" />}
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
