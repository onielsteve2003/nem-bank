import { useRouter } from 'expo-router';
import { Plus, Target } from 'lucide-react-native';
import { View } from 'react-native';

import {
  Button,
  EmptyState,
  ErrorState,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
} from '@/components';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { useRepoQuery } from '@/lib/query';
import { usePrivacyStore } from '@/stores';
import { useTheme } from '@/theme';

import { GoalRow } from '../components/GoalRow';
import { sortGoals } from '../goals';

/** Every savings goal (SAV-2): open ones closest to done first, then closed ones. */
export function GoalsScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const hidden = usePrivacyStore((s) => s.balancesHidden);
  const goals = useRepoQuery('savings', 'listGoals');
  const sorted = goals.data ? sortGoals(goals.data.data) : [];
  const open = sorted.filter((g) => g.status !== 'closed');
  const closed = sorted.filter((g) => g.status === 'closed');
  const row = (g: (typeof sorted)[number]) => (
    <GoalRow
      key={g.id}
      goal={g}
      hidden={hidden}
      onPress={() => router.push({ pathname: '/goals/[id]', params: { id: g.id } })}
    />
  );

  return (
    <Screen
      header={<SendHeader title="Savings goals" first />}
      edges={['top', 'bottom']}
      footer={<Button label="New goal" icon={Plus} onPress={() => router.push('/goals/new')} />}
      onRefresh={() => void goals.refetch()}
      refreshing={goals.isRefetching}
    >
      {goals.isError ? (
        <ErrorState title="We couldn't load your goals" onRetry={() => goals.refetch()} />
      ) : !goals.data ? (
        <SkeletonGroup accessibilityLabel="Loading goals">
          <Skeleton height={88} />
          <Skeleton height={88} />
        </SkeletonGroup>
      ) : open.length === 0 && closed.length === 0 ? (
        <EmptyState
          icon={Target}
          title="No goals yet"
          message="Name what you're saving for, set a target and watch it grow. Goals earn 10% a year."
        />
      ) : (
        <>
          <View style={{ gap: spacing[3] }}>{open.map(row)}</View>
          {closed.length > 0 && (
            <View style={{ gap: spacing[3] }}>
              <SectionHeader title="Closed" />
              {closed.map(row)}
            </View>
          )}
        </>
      )}
    </Screen>
  );
}
