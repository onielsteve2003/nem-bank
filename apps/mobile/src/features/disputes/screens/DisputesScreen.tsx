import type { Schema } from '@nem/contracts';
import { useRouter } from 'expo-router';
import { Flag } from 'lucide-react-native';
import { View } from 'react-native';

import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
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

import { DISPUTE_STATUS, isOpen, reasonLabel } from '../disputes';

/** Your dispute tracker (DSP-2): open cases first, then the closed ones. */
export function DisputesScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const q = useRepoQuery('disputes', 'list', { query: { limit: 50 } });
  const header = <SendHeader title="Disputes" first />;

  if (!q.data) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        {q.isError ? (
          <ErrorState title="We couldn't load your disputes" onRetry={() => q.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel="Loading your disputes">
            <Skeleton height={88} />
            <Skeleton height={88} />
          </SkeletonGroup>
        )}
      </Screen>
    );
  }

  const all = q.data.data;
  if (!all.length) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <EmptyState
          icon={Flag}
          title="No disputes"
          message="If something's wrong with a payment, open it from your transactions and tap Report a problem."
        />
      </Screen>
    );
  }

  const row = (d: Schema<'Dispute'>) => {
    const status = DISPUTE_STATUS[d.status];
    return (
      <Card
        key={d.id}
        onPress={() => router.push({ pathname: '/disputes/[id]', params: { id: d.id } })}
        accessibilityLabel={`${d.case_number}, ${reasonLabel(d.reason)}, ${status.label}`}
      >
        <View style={{ gap: spacing[1] }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing[2] }}>
            <Text variant="bodyStrong">{d.case_number}</Text>
            <Badge label={status.label} tone={status.tone} />
          </View>
          <Text variant="bodySmall" color="textMuted">
            {`${reasonLabel(d.reason)} · ${formatDateTime(d.created_at)}`}
          </Text>
        </View>
      </Card>
    );
  };

  const open = all.filter(isOpen);
  const closed = all.filter((d) => !isOpen(d));
  return (
    <Screen
      header={header}
      edges={['top', 'bottom']}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      {open.length > 0 && <SectionHeader title="Open" />}
      {open.map(row)}
      {closed.length > 0 && <SectionHeader title="Closed" />}
      {closed.map(row)}
    </Screen>
  );
}
