import type { Schema } from '@nem/contracts';
import { useRouter } from 'expo-router';
import { BellOff, CheckCheck, Settings2, X } from 'lucide-react-native';
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
import { useTranslation } from 'react-i18next';

/** The notification inbox (NOT-1): newest first, unread marked, each opens where it's about. */
export function NotificationsScreen() {
  const router = useRouter();
  const toast = useToast();
  const { colors, radius, spacing } = useTheme();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const { t } = useTranslation();
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
        {t('notifications.inbox.title')}
      </Text>
      <IconButton
        icon={CheckCheck}
        variant="ghost"
        accessibilityLabel={t('notifications.inbox.markAll')}
        disabled={unread === 0 || markRead.isPending}
        onPress={() =>
          markRead.mutate(
            { body: { all: true } },
            {
              onSuccess: () =>
                toast.show({ message: t('notifications.inbox.allCaught'), tone: 'success' }),
            },
          )
        }
      />
      <IconButton
        icon={Settings2}
        variant="ghost"
        accessibilityLabel={t('notifications.inbox.settings')}
        onPress={() => router.push('/notifications/preferences')}
      />
      {/* A full-screen modal has no swipe to close, so it needs a way out. */}
      <IconButton
        icon={X}
        variant="ghost"
        accessibilityLabel={t('common.close')}
        onPress={() => router.back()}
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
        accessibilityLabel={`${n.read ? '' : t('notifications.inbox.unreadPrefix')}${n.title}. ${n.body}. ${formatDateTime(n.created_at)}`}
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
              {!n.read && (
                <Badge dot tone="primary" accessibilityLabel={t('notifications.inbox.unread')} />
              )}
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
      <ErrorState title={t('notifications.inbox.failed')} onRetry={() => q.refetch()} />
    ) : (
      <SkeletonGroup accessibilityLabel={t('notifications.inbox.loading')}>
        <SkeletonListItem />
        <SkeletonListItem />
        <SkeletonListItem />
      </SkeletonGroup>
    );
  } else if (!q.data.data.length) {
    body = (
      <EmptyState
        icon={BellOff}
        title={unreadOnly ? t('notifications.inbox.allCaught') : t('notifications.inbox.none')}
        message={
          unreadOnly ? t('notifications.inbox.readAll') : t('notifications.inbox.noneMessage')
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
        <Chip
          label={t('notifications.inbox.all')}
          selected={!unreadOnly}
          onPress={() => setUnreadOnly(false)}
        />
        <Chip
          label={
            unread
              ? t('notifications.inbox.unreadCount', { count: unread })
              : t('notifications.inbox.unread')
          }
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
