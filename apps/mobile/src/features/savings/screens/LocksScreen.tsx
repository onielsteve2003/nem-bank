import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { useRouter } from 'expo-router';
import { Lock, Plus } from 'lucide-react-native';
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
} from '@/components';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { fromApiMoney } from '@/lib/money';
import { useRepoQuery } from '@/lib/query';
import { usePrivacyStore } from '@/stores';
import { useTheme } from '@/theme';

import { formatGoalDate } from '../goals';
import { LOCK_STATUS, ratePct, sortLocks, termLabel } from '../locks';

type LockedSaving = Schema<'LockedSaving'>;

/** Every locked saving (SAV-4): active ones soonest to mature first, then the ones that ended. */
export function LocksScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const hidden = usePrivacyStore((s) => s.balancesHidden);
  const locks = useRepoQuery('savings', 'listLocks');
  const sorted = locks.data ? sortLocks(locks.data.data) : [];
  const active = sorted.filter((l) => l.status === 'active');
  const ended = sorted.filter((l) => l.status !== 'active');

  const row = (l: LockedSaving) => {
    const amount = hidden ? '••••' : formatMoney(fromApiMoney(l.principal));
    const subtitle =
      l.status === 'active'
        ? `${ratePct(l.rate_bps)} a year · matures ${formatGoalDate(l.maturity_date)}`
        : `${ratePct(l.rate_bps)} a year · ${termLabel(l.term_days)}`;
    return (
      <ListItem
        key={l.id}
        leading={Lock}
        title={`${amount} · ${termLabel(l.term_days)}`}
        subtitle={subtitle}
        trailing={
          <Badge
            label={LOCK_STATUS[l.status]}
            tone={
              l.status === 'active' ? 'primary' : l.status === 'matured' ? 'success' : 'neutral'
            }
          />
        }
        onPress={() => router.push({ pathname: '/locks/[id]', params: { id: l.id } })}
        accessibilityLabel={`${amount} locked for ${termLabel(l.term_days)}. ${subtitle}. ${LOCK_STATUS[l.status]}`}
      />
    );
  };

  return (
    <Screen
      header={<SendHeader title="Locked savings" first />}
      edges={['top', 'bottom']}
      footer={<Button label="Lock money" icon={Plus} onPress={() => router.push('/locks/new')} />}
      onRefresh={() => void locks.refetch()}
      refreshing={locks.isRefetching}
    >
      {locks.isError ? (
        <ErrorState title="We couldn't load your locked savings" onRetry={() => locks.refetch()} />
      ) : !locks.data ? (
        <SkeletonGroup accessibilityLabel="Loading locked savings">
          <Skeleton height={72} />
          <Skeleton height={72} />
        </SkeletonGroup>
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={Lock}
          title="Nothing locked yet"
          message="Lock money away for 30 days to a year and earn up to 18% a year. The rate is fixed the day you lock."
        />
      ) : (
        <>
          {active.length > 0 && <Card padded={false}>{active.map(row)}</Card>}
          {ended.length > 0 && (
            <View style={{ gap: spacing[2] }}>
              <SectionHeader title="Ended" />
              <Card padded={false}>{ended.map(row)}</Card>
            </View>
          )}
        </>
      )}
    </Screen>
  );
}
