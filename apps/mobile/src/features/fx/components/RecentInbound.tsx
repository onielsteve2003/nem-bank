import type { Schema } from '@nem/contracts';
import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { ErrorState, SkeletonGroup, SkeletonListItem, Text } from '@/components';
import { TransactionRow } from '@/features/transactions/TransactionRow';
import { useRepoQuery } from '@/lib/query';

export const RECENT_INBOUND = 3;

/** The latest payments into one foreign wallet, so the customer sees the money land. */
export function RecentInbound({ account }: { account: Schema<'Account'> }) {
  const router = useRouter();
  const recent = useRepoQuery('transactions', 'list', {
    query: { account_id: account.id, type: ['transfer_in'], limit: RECENT_INBOUND },
  });

  if (recent.isError) {
    return <ErrorState title="We couldn't load payments" onRetry={() => recent.refetch()} />;
  }
  if (!recent.data) {
    return (
      <SkeletonGroup accessibilityLabel="Loading payments">
        <SkeletonListItem />
      </SkeletonGroup>
    );
  }
  if (recent.data.data.length === 0) {
    return (
      <Text variant="bodySmall" color="textMuted">
        Nothing yet. Payments into your {account.currency} wallet show up here.
      </Text>
    );
  }
  return (
    <View>
      {recent.data.data.map((t) => (
        <TransactionRow
          key={t.id}
          transaction={t}
          onPress={() => router.push(`/transactions/${t.id}`)}
        />
      ))}
    </View>
  );
}
