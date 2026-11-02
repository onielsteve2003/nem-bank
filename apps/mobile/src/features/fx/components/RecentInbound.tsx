import type { Schema } from '@nem/contracts';
import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { ErrorState, SkeletonGroup, SkeletonListItem, Text } from '@/components';
import { TransactionRow } from '@/features/transactions/TransactionRow';
import { useRepoQuery } from '@/lib/query';
import { useTranslation } from 'react-i18next';

export const RECENT_INBOUND = 3;

/** The latest payments into one foreign wallet, so the customer sees the money land. */
export function RecentInbound({ account }: { account: Schema<'Account'> }) {
  const router = useRouter();
  const { t } = useTranslation();
  const recent = useRepoQuery('transactions', 'list', {
    query: { account_id: account.id, type: ['transfer_in'], limit: RECENT_INBOUND },
  });

  if (recent.isError) {
    return <ErrorState title={t('fx.receive.paymentsFailed')} onRetry={() => recent.refetch()} />;
  }
  if (!recent.data) {
    return (
      <SkeletonGroup accessibilityLabel={t('fx.receive.loadingPayments')}>
        <SkeletonListItem />
      </SkeletonGroup>
    );
  }
  if (recent.data.data.length === 0) {
    return (
      <Text variant="bodySmall" color="textMuted">
        {t('fx.receive.nothingYet', { currency: account.currency })}
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
