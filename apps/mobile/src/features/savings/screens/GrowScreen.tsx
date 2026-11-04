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
} from '@/components/icons';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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
      title: t('savings.goals.title'),
      subtitle: s
        ? t('savings.grow.goalsSubtitle', { count: s.goals_count })
        : t('savings.grow.goalsIdle'),
      icon: Target,
      onPress: () => router.push('/goals'),
    },
    {
      key: 'roundups',
      title: t('savings.grow.roundUps'),
      subtitle: roundUps.data
        ? roundUps.data.enabled
          ? t('savings.grow.roundUpsOn')
          : t('savings.grow.roundUpsOff')
        : t('savings.grow.roundUpsIdle'),
      icon: Coins,
      onPress: () => router.push('/round-ups'),
    },
    {
      key: 'locks',
      title: t('savings.grow.locks'),
      subtitle: s
        ? s.locks_count > 0
          ? t('savings.grow.locksActive', { count: s.locks_count })
          : t('savings.grow.locksNone')
        : t('savings.grow.locksIdle'),
      icon: Lock,
      onPress: () => router.push('/locks'),
    },
    {
      key: 'ajo',
      title: t('savings.grow.ajo'),
      subtitle:
        ajoCount !== undefined && ajoCount > 0
          ? t('savings.grow.ajoGroups', { count: ajoCount })
          : t('savings.grow.ajoIdle'),
      icon: Users,
      onPress: () => router.push('/ajo'),
    },
  ];
  const more: Entry[] = [
    {
      key: 'credit',
      title: t('savings.grow.credit'),
      subtitle: t('savings.grow.creditSubtitle'),
      icon: HandCoins,
      onPress: () => router.push('/credit'),
    },
    {
      key: 'insights',
      title: t('savings.grow.insights'),
      subtitle: t('savings.grow.insightsSubtitle'),
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
          trailing={e.onPress ? undefined : <Badge label={t('savings.grow.soon')} tone="neutral" />}
          accessibilityLabel={
            t('savings.grow.entryLabel', { title: e.title, subtitle: e.subtitle }) +
            (e.onPress ? '' : `. ${t('savings.grow.comingSoon')}`)
          }
        />
      ))}
    </Card>
  );

  const header = (
    <View style={[styles.header, { paddingHorizontal: spacing[4], gap: spacing[2] }]}>
      <Text variant="title" accessibilityRole="header" style={styles.flex}>
        {t('savings.grow.title')}
      </Text>
      <IconButton
        icon={hidden ? EyeOff : Eye}
        accessibilityLabel={t(hidden ? 'home.showBalances' : 'home.hideBalances')}
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
              {t('savings.grow.totalSaved')}
            </Text>
            <MoneyText
              value={fromApiMoney(s.total_saved)}
              variant="amountLarge"
              masked={hidden}
              animate
              label={t('savings.grow.totalSaved')}
            />
          </View>
          <View style={[styles.stats, { gap: spacing[4] }]}>
            <View style={[styles.flex, { gap: spacing[1] }]}>
              <Text variant="caption" color="textMuted">
                {t('savings.grow.interestEarned')}
              </Text>
              <MoneyText
                value={fromApiMoney(s.interest_earned)}
                variant="bodyStrong"
                color="success"
                masked={hidden}
                signPositive
                label={t('savings.grow.interestEarned')}
              />
            </View>
            <View style={[styles.flex, { gap: spacing[1] }]}>
              <Text variant="caption" color="textMuted">
                {t('savings.grow.roundUpsMonth')}
              </Text>
              <MoneyText
                value={fromApiMoney(s.round_ups_this_month)}
                variant="bodyStrong"
                masked={hidden}
                label={t('savings.grow.roundUpsMonth')}
              />
            </View>
          </View>
          <Text variant="caption" color="textMuted">
            {t('savings.grow.interestNote')}
          </Text>
        </View>
      ) : summary.isError ? (
        <ErrorState title={t('savings.grow.failed')} onRetry={() => summary.refetch()} />
      ) : (
        <SkeletonGroup accessibilityLabel={t('savings.grow.loading')}>
          <Skeleton height={168} radius={24} />
        </SkeletonGroup>
      )}

      <View style={{ gap: spacing[2] }}>
        <SectionHeader
          title={t('savings.grow.yourGoals')}
          actionLabel={goals.data && goals.data.data.length > 0 ? t('common.seeAll') : undefined}
          onAction={() => router.push('/goals')}
          actionAccessibilityLabel={t('savings.grow.seeAllGoals')}
        />
        {goals.isError ? (
          <ErrorState title={t('savings.goals.failed')} onRetry={() => goals.refetch()} />
        ) : !goals.data ? (
          <SkeletonGroup accessibilityLabel={t('savings.goals.loading')}>
            <Skeleton height={88} />
            <Skeleton height={88} />
          </SkeletonGroup>
        ) : open.length === 0 ? (
          <EmptyState
            icon={Target}
            title={t('savings.goals.emptyTitle')}
            message={t('savings.grow.emptyMessage')}
            actionLabel={t('savings.grow.startGoal')}
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
        <SectionHeader title={t('savings.grow.waysToSave')} />
        {entryList(save)}
      </View>

      <View style={{ gap: spacing[2] }}>
        <SectionHeader title={t('savings.grow.borrowPlan')} />
        {entryList(more)}
      </View>

      <Text variant="caption" color="textMuted">
        {t('savings.grow.demo')}
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', minHeight: 56 },
  stats: { flexDirection: 'row' },
  flex: { flex: 1 },
});
