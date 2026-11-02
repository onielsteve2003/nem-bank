import type { Schema } from '@nem/contracts';
import { useRouter } from 'expo-router';
import { BookOpen, MessageCircle, Plus } from 'lucide-react-native';
import { View } from 'react-native';

import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ListItem,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
} from '@/components';
import { formatDateTime } from '@/features/transactions/format';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { CONVERSATION_STATUS } from '../support';

/** Help and support: the help center (SUP-2) and your chats with the team (SUP-1). */
export function SupportScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const q = useRepoQuery('support', 'listConversations');
  const header = <SendHeader title="Help and support" first />;
  const footer = (
    <Button label="Start a chat" icon={Plus} onPress={() => router.push('/support/new')} />
  );

  const row = (c: Schema<'SupportConversation'>) => {
    const status = CONVERSATION_STATUS[c.status];
    return (
      <Card
        key={c.id}
        onPress={() => router.push({ pathname: '/support/[id]', params: { id: c.id } })}
        accessibilityLabel={`${c.subject}, ${status.label}${c.unread_count ? `, ${c.unread_count} new` : ''}`}
      >
        <View style={{ gap: spacing[1] }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing[2] }}>
            <Text variant="bodyStrong" style={{ flex: 1 }} numberOfLines={1}>
              {c.subject}
            </Text>
            <Badge count={c.unread_count} tone="primary" />
            <Badge label={status.label} tone={status.tone} />
          </View>
          <Text variant="bodySmall" color="textMuted">
            {`${c.assigned_agent ?? 'Waiting for an agent'} · ${formatDateTime(c.last_message_at)}`}
          </Text>
        </View>
      </Card>
    );
  };

  let body;
  if (!q.data) {
    body = q.isError ? (
      <ErrorState title="We couldn't load your chats" onRetry={() => q.refetch()} />
    ) : (
      <SkeletonGroup accessibilityLabel="Loading your chats">
        <Skeleton height={72} />
        <Skeleton height={72} />
      </SkeletonGroup>
    );
  } else if (!q.data.data.length) {
    body = (
      <EmptyState
        icon={MessageCircle}
        title="No chats yet"
        message="Start a chat and someone from our team will reply here, usually within minutes."
      />
    );
  } else {
    body = (
      <>
        <SectionHeader title="Your chats" />
        {q.data.data.map(row)}
      </>
    );
  }

  return (
    <Screen
      header={header}
      footer={footer}
      edges={['top', 'bottom']}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      <Card padded={false}>
        <ListItem
          title="Help center"
          subtitle="Search answers to common questions"
          leading={BookOpen}
          onPress={() => router.push('/support/help')}
        />
      </Card>
      {body}
    </Screen>
  );
}
