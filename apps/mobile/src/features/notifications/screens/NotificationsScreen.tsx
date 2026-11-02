import type { Schema } from '@nem/contracts';
import { useRouter } from 'expo-router';
import { BellOff, CheckCheck, Settings2 } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Badge,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  Screen,
  SectionHeader,
  SkeletonGroup,
  SkeletonListItem,
  Text,
  useToast,
} from '@/components';
import { formatDateTime } from '@/features/transactions/format';
import { resolveDeepLink } from '@/lib/deepLinks';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { categoryMeta, groupByDay } from '../notifications';

/** The notification inbox (NOT-1): newest first, unread marked, each opens where it's about. */
export function NotificationsScreen() {
  const router = useRouter();
  const toast = useToast();
  const { colors, radius, spacing } = useTheme();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const q = useRepoQuery('notifications', 'list', {
    query: { limit: 100, ...(unreadOnly ? { unread_only: true } : {}) },
  });
  const markRead = useRepoMutation('notifications', 'markRead');
  const unread = q.data?.unread_count ?? 0;

  const open = (n: Schema<'Notification'>) => {
    if (!n.read) markRead.mutate({ body: { ids: [n.id] } });
    if (n.deep_link) router.push(resolveDeepLink(n.deep_link).href);
  };

  const header = (
    <View style={[styles.header, { paddingHorizontal: spacing[4], gap: spacing[1] }]}>
      <Text variant="title" accessibilityRole="header" style={styles.flex}>
        Notifications
      </Text>
      <IconButton
        icon={CheckCheck}
        variant="ghost"
        accessibilityLabel="Mark all as read"
        disabled={unread === 0 || markRead.isPending}
        onPress={() =>
          markRead.mutate(
            { body: { all: true } },
            { onSuccess: () => toast.show({ message: 'All caught up', tone: 'success' }) },
          )
        }
      />
      <IconButton
        icon={Settings2}
        variant="ghost"
        accessibilityLabel="Notification settings"
        onPress={() => router.push('/notifications/preferences')}
      />
    </View>
  );

  const row = (n: Schema<'Notification'>) => {
    const meta = categoryMeta(n.category);
    return (
      <Card
        key={n.id}
        variant={n.read ? 'surface' : 'raised'}
        onPress={() => open(n)}
        accessibilityLabel={`${n.read ? '' : 'Unread. '}${n.title}. ${n.body}. ${formatDateTime(n.created_at)}`}
      >
        <View style={[styles.row, { gap: spacing[3] }]}>
          <View
            style={[styles.icon, { backgroundColor: colors.background, borderRadius: radius.pill }]}
          >
            <Icon icon={meta.icon} color={n.read ? 'textMuted' : 'primaryText'} />
          </View>
          <View style={[styles.flex, { gap: spacing[1] }]}>
            <View style={[styles.row, { gap: spacing[2] }]}>
              <Text variant="bodyStrong" style={styles.flex} numberOfLines={2}>
                {n.title}
              </Text>
              {!n.read && <Badge dot tone="primary" accessibilityLabel="Unread" />}
            </View>
            <Text variant="bodySmall" color="textMuted">
              {n.body}
            </Text>
            <Text variant="caption" color="textMuted">
              {`${meta.label} · ${formatDateTime(n.created_at)}`}
            </Text>
          </View>
        </View>
      </Card>
    );
  };

  let body;
  if (!q.data) {
    body = q.isError ? (
      <ErrorState title="We couldn't load your notifications" onRetry={() => q.refetch()} />
    ) : (
      <SkeletonGroup accessibilityLabel="Loading your notifications">
        <SkeletonListItem />
        <SkeletonListItem />
        <SkeletonListItem />
      </SkeletonGroup>
    );
  } else if (!q.data.data.length) {
    body = (
      <EmptyState
        icon={BellOff}
        title={unreadOnly ? 'All caught up' : 'No notifications'}
        message={
          unreadOnly
            ? 'You’ve read everything.'
            : 'Payments, security alerts and replies from support show up here.'
        }
      />
    );
  } else {
    body = groupByDay(q.data.data).map((g) => (
      <View key={g.title} style={{ gap: spacing[2] }}>
        <SectionHeader title={g.title} />
        {g.items.map(row)}
      </View>
    ));
  }

  return (
    <Screen
      header={header}
      edges={['top', 'bottom']}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      <View style={[styles.row, { gap: spacing[2] }]}>
        <Chip label="All" selected={!unreadOnly} onPress={() => setUnreadOnly(false)} />
        <Chip
          label={unread ? `Unread (${unread})` : 'Unread'}
          selected={unreadOnly}
          onPress={() => setUnreadOnly(true)}
        />
      </View>
      {body}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  icon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
});
