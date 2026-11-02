import type { Schema } from '@nem/contracts';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Card,
  Divider,
  ErrorState,
  Icon,
  Screen,
  Skeleton,
  SkeletonGroup,
  Switch,
  Text,
  useToast,
} from '@/components';
import { isApiError } from '@/data';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { PhoneAlertsCard } from '../components/PhoneAlertsCard';
import {
  CATEGORIES,
  CHANNELS,
  isLocked,
  setChannel,
  type Category,
  type Channel,
} from '../notifications';

type Prefs = Schema<'NotificationPreferences'>;

const message = (e: unknown) =>
  isApiError(e)
    ? e.problem.code === 'offline'
      ? "You're offline, so that didn't save."
      : (e.problem.detail ?? e.problem.title)
    : "That didn't save. Try again.";

/**
 * What Nem tells you about, and where (NOT-2): in the app, by push and by
 * email, per category. Each switch saves at once. Security alerts always
 * reach the inbox; offers are off until you turn them on.
 */
export function NotificationPreferencesScreen() {
  const toast = useToast();
  const { spacing } = useTheme();
  const q = useRepoQuery('notifications', 'getPreferences');
  const save = useRepoMutation('notifications', 'setPreferences');
  /** What the customer last chose, shown while it saves and after. */
  const [chosen, setChosen] = useState<Prefs>();
  const prefs = chosen ?? q.data;

  const toggle = (category: Category, channel: Channel, on: boolean) => {
    if (!prefs) return;
    const next = setChannel(prefs, category, channel, on);
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

  let body;
  if (q.isError && !prefs) {
    body = <ErrorState title="We couldn't load your settings" onRetry={() => q.refetch()} />;
  } else if (!prefs) {
    body = (
      <SkeletonGroup accessibilityLabel="Loading your settings">
        <Skeleton height={180} />
        <Skeleton height={180} />
      </SkeletonGroup>
    );
  } else {
    body = CATEGORIES.map((c) => (
      <View key={c.value} style={{ gap: spacing[2] }}>
        <View style={[styles.row, { gap: spacing[2] }]}>
          <Icon icon={c.icon} color="textMuted" />
          <View style={styles.flex}>
            <Text variant="bodyStrong" accessibilityRole="header">
              {c.label}
            </Text>
            <Text variant="bodySmall" color="textMuted">
              {c.hint}
            </Text>
          </View>
        </View>
        <Card>
          {CHANNELS.map((ch, i) => (
            <View key={ch.value}>
              {i > 0 && <Divider />}
              <Switch
                label={ch.label}
                accessibilityLabel={`${c.label}: ${ch.label}`}
                description={
                  isLocked(c.value, ch.value) ? 'Always on, to keep you safe' : undefined
                }
                value={prefs.categories[c.value][ch.value]}
                disabled={isLocked(c.value, ch.value)}
                onValueChange={(on) => toggle(c.value, ch.value, on)}
              />
            </View>
          ))}
        </Card>
      </View>
    ));
  }

  return (
    <Screen header={<SendHeader title="Notification settings" />} edges={['top', 'bottom']}>
      <Text variant="bodySmall" color="textMuted">
        Choose what we tell you about and where. Offers stay off unless you turn them on.
      </Text>
      <PhoneAlertsCard />
      {body}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
