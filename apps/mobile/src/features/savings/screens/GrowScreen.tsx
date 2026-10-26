import { useRouter } from 'expo-router';
import {
  ChartPie,
  Coins,
  Eye,
  EyeOff,
  HandCoins,
  Lock,
  Target,
  Users,
  type LucideIcon,
} from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  IconButton,
  ListItem,
  MoneyText,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
} from '@/components';
import { fromApiMoney } from '@/lib/money';
import { useRepoQuery } from '@/lib/query';
import { usePrivacyStore } from '@/stores';
import { useTheme } from '@/theme';

import { GoalRow } from '../components/GoalRow';
import { sortGoals } from '../goals';

const PREVIEW = 3;

interface Entry {
  key: string;
  title: string;
  subtitle: string;
  icon: LucideIcon;
  /** Unset while the feature is still being built. */
  onPress?: () => void;
}

/**
 * Grow tab (SAV-1): everything saved and the interest it has earned, the
 * goals closest to done, and the ways in to goals, round-ups, locked
 * savings, ajo, credit and insights.
 */
export function GrowScreen() {
  const router = useRouter();
  const { colors, radius, spacing } = useTheme();
  const hidden = usePrivacyStore((s) => s.balancesHidden);
  const toggleBalances = usePrivacyStore((s) => s.toggleBalances);

  const summary = useRepoQuery('savings', 'getSummary');
  const goals = useRepoQuery('savings', 'listGoals');
  const roundUps = useRepoQuery('savings', 'getRoundUps');
  const ajo = useRepoQuery('ajo', 'listGroups');

  const open = goals.data ? sortGoals(goals.data.data).filter((g) => g.status !== 'closed') : [];
  const s = summary.data;
  const ajoCount = ajo.data?.data.length;

  const save: Entry[] = [
    {
      key: 'goals',
      title: 'Savings goals',
      subtitle: s ? `${s.goals_count} open · 10% a year` : 'Save towards something',
      icon: Target,
      onPress: () => router.push('/goals'),
    },
    {
      key: 'roundups',
      title: 'Round-ups',
      subtitle: roundUps.data
        ? roundUps.data.enabled
          ? 'On · spare change into a goal'
          : 'Off · save the change from every spend'
        : 'Save the change from every spend',
      icon: Coins,
      onPress: () => router.push('/round-ups'),
    },
    {
      key: 'locks',
      title: 'Locked savings',
      subtitle: s
        ? s.locks_count > 0
          ? `${s.locks_count} active · up to 18% a year`
          : 'Up to 18% a year for 30 to 365 days'
        : 'Up to 18% a year',
      icon: Lock,
      onPress: () => router.push('/locks'),
    },
    {
      key: 'ajo',
      title: 'Ajo',
      subtitle:
        ajoCount !== undefined && ajoCount > 0
          ? `${ajoCount} ${ajoCount === 1 ? 'group' : 'groups'}`
          : 'Save in turns with people you trust',
      icon: Users,
      onPress: () => router.push('/ajo'),
    },
  ];
  const more: Entry[] = [
    {
      key: 'credit',
      title: 'Credit',
      subtitle: 'See what you could borrow',
      icon: HandCoins,
      onPress: () => router.push('/credit'),
    },
    {
      key: 'insights',
      title: 'Insights and budgets',
      subtitle: 'Where your money goes each month',
      icon: ChartPie,
      onPress: () => router.push('/insights'),
    },
  ];

  const entryList = (entries: Entry[]) => (
    <Card padded={false}>
      {entries.map((e) => (
        <ListItem
          key={e.key}
          leading={e.icon}
          title={e.title}
          subtitle={e.subtitle}
          onPress={e.onPress}
          trailing={e.onPress ? undefined : <Badge label="Soon" tone="neutral" />}
          accessibilityLabel={`${e.title}. ${e.subtitle}${e.onPress ? '' : '. Coming soon'}`}
        />
      ))}
    </Card>
  );

  const header = (
    <View style={[styles.header, { paddingHorizontal: spacing[4], gap: spacing[2] }]}>
      <Text variant="title" accessibilityRole="header" style={styles.flex}>
        Grow
      </Text>
      <IconButton
        icon={hidden ? EyeOff : Eye}
        accessibilityLabel={hidden ? 'Show balances' : 'Hide balances'}
        variant="ghost"
        onPress={toggleBalances}
      />
    </View>
  );

  return (
    <Screen
      header={header}
      edges={['top']}
      onRefresh={() =>
        void Promise.all([summary.refetch(), goals.refetch(), roundUps.refetch(), ajo.refetch()])
      }
      refreshing={summary.isRefetching || goals.isRefetching}
    >
      {s ? (
        <View
          accessibilityRole="summary"
          style={[
            {
              backgroundColor: colors.surface,
              borderRadius: radius.xl,
              padding: spacing[5],
              gap: spacing[4],
            },
          ]}
        >
          <View style={{ gap: spacing[1] }}>
            <Text variant="label" color="textMuted">
              Total saved
            </Text>
            <MoneyText
              value={fromApiMoney(s.total_saved)}
              variant="amountLarge"
              masked={hidden}
              animate
              label="Total saved"
            />
          </View>
          <View style={[styles.stats, { gap: spacing[4] }]}>
            <View style={[styles.flex, { gap: spacing[1] }]}>
              <Text variant="caption" color="textMuted">
                Interest earned
              </Text>
              <MoneyText
                value={fromApiMoney(s.interest_earned)}
                variant="bodyStrong"
                color="success"
                masked={hidden}
                signPositive
                label="Interest earned"
              />
            </View>
            <View style={[styles.flex, { gap: spacing[1] }]}>
              <Text variant="caption" color="textMuted">
                Round-ups this month
              </Text>
              <MoneyText
                value={fromApiMoney(s.round_ups_this_month)}
                variant="bodyStrong"
                masked={hidden}
                label="Round-ups this month"
              />
            </View>
          </View>
          <Text variant="caption" color="textMuted">
            Goals and locked savings earn interest every day, paid into each one.
          </Text>
        </View>
      ) : summary.isError ? (
        <ErrorState title="We couldn't load your savings" onRetry={() => summary.refetch()} />
      ) : (
        <SkeletonGroup accessibilityLabel="Loading your savings">
          <Skeleton height={168} radius={24} />
        </SkeletonGroup>
      )}

      <View style={{ gap: spacing[2] }}>
        <SectionHeader
          title="Your goals"
          actionLabel={goals.data && goals.data.data.length > 0 ? 'See all' : undefined}
          onAction={() => router.push('/goals')}
          actionAccessibilityLabel="See all goals"
        />
        {goals.isError ? (
          <ErrorState title="We couldn't load your goals" onRetry={() => goals.refetch()} />
        ) : !goals.data ? (
          <SkeletonGroup accessibilityLabel="Loading goals">
            <Skeleton height={88} />
            <Skeleton height={88} />
          </SkeletonGroup>
        ) : open.length === 0 ? (
          <EmptyState
            icon={Target}
            title="No goals yet"
            message="Name what you're saving for, set a target and watch it grow."
            actionLabel="Start a goal"
            onAction={() => router.push('/goals/new')}
          />
        ) : (
          open
            .slice(0, PREVIEW)
            .map((g) => (
              <GoalRow
                key={g.id}
                goal={g}
                hidden={hidden}
                onPress={() => router.push({ pathname: '/goals/[id]', params: { id: g.id } })}
              />
            ))
        )}
      </View>

      <View style={{ gap: spacing[2] }}>
        <SectionHeader title="Ways to save" />
        {entryList(save)}
      </View>

      <View style={{ gap: spacing[2] }}>
        <SectionHeader title="Borrow and plan" />
        {entryList(more)}
      </View>

      <Text variant="caption" color="textMuted">
        Demo money: interest is simulated and paid by Nem&apos;s test ledger.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', minHeight: 56 },
  stats: { flexDirection: 'row' },
  flex: { flex: 1 },
});
