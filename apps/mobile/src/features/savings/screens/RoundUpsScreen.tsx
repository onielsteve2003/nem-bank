import type { Schema } from '@nem/contracts';
import { formatMoney, money } from '@nem/shared';
import { useRouter } from 'expo-router';
import { Coins } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import {
  Card,
  Chip,
  EmptyState,
  ErrorState,
  ListItem,
  MoneyText,
  Screen,
  SectionHeader,
  SelectSheet,
  Skeleton,
  SkeletonGroup,
  SkeletonListItem,
  Switch,
  Text,
} from '@/components';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { formatWhen } from '@/features/transactions/TransactionRow';
import { fromApiMoney } from '@/lib/money';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { usePrivacyStore } from '@/stores';
import { useTheme } from '@/theme';

type Settings = Schema<'RoundUpSettings'>;
type Source = Settings['sources'][number];

const STEPS: { value: Settings['round_to']; label: string }[] = [
  { value: '10000', label: '₦100' },
  { value: '50000', label: '₦500' },
  { value: '100000', label: '₦1,000' },
];
const SOURCES: { value: Source; label: string; description: string }[] = [
  { value: 'card', label: 'Card payments', description: 'Online and in-store card spends' },
  { value: 'transfer', label: 'Transfers', description: 'Money you send to anyone' },
];
const EXAMPLE_SPEND = 123_000n;
const HISTORY = 20;

/** What a ₦1,230 spend would put away at this step, as an example. */
export function roundUpExample(step: Settings['round_to']): string {
  const s = BigInt(step);
  const rest = EXAMPLE_SPEND % s;
  return `A ${formatMoney(money(EXAMPLE_SPEND, 'NGN'))} spend saves ${formatMoney(money(rest === 0n ? 0n : s - rest, 'NGN'))}`;
}

/**
 * Round-ups (SAV-3): naira card and transfer spends are rounded up to the next
 * ₦100, ₦500 or ₦1,000 and the change goes into one goal. Every change saves
 * straight away; the history lists each round-up made.
 */
export function RoundUpsScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const hidden = usePrivacyStore((s) => s.balancesHidden);
  const settings = useRepoQuery('savings', 'getRoundUps');
  const goals = useRepoQuery('savings', 'listGoals');
  const history = useRepoQuery('transactions', 'list', {
    query: { q: 'round-up', type: ['savings'], limit: HISTORY },
  });
  const update = useRepoMutation('savings', 'setRoundUps', {
    invalidates: [['savings'], ['transactions']],
  });

  // Show the change being saved, so switches never jump back while it is in flight.
  const s = update.isPending ? update.variables.body : settings.data;
  const open = (goals.data?.data ?? []).filter((g) => g.status === 'active');
  const save = (patch: Partial<Settings>) => {
    if (!s) return;
    const next = { ...s, ...patch };
    // Round-ups need somewhere to go: default to the first open goal.
    if (next.enabled && !open.some((g) => g.id === next.goal_id))
      next.goal_id = open[0]?.id ?? null;
    update.mutate({ body: next });
  };
  const toggleSource = (source: Source, on: boolean) => {
    if (!s) return;
    const sources = on ? [...s.sources, source] : s.sources.filter((x) => x !== source);
    // At least one kind of spend has to count; turning off the last one turns round-ups off.
    if (sources.length === 0) save({ enabled: false });
    else save({ sources });
  };

  const settingsCard = () => {
    if (settings.isError || goals.isError) {
      return (
        <ErrorState
          title="We couldn't load your round-ups"
          onRetry={() => void Promise.all([settings.refetch(), goals.refetch()])}
        />
      );
    }
    if (!s || !goals.data) {
      return (
        <SkeletonGroup accessibilityLabel="Loading round-ups">
          <Skeleton height={220} />
        </SkeletonGroup>
      );
    }
    if (open.length === 0) {
      return (
        <EmptyState
          icon={Coins}
          title="Start a goal first"
          message="Round-ups need a goal to save into. Make one, then come back here."
          actionLabel="Start a goal"
          onAction={() => router.push('/goals/new')}
        />
      );
    }
    return (
      <View style={{ gap: spacing[4] }}>
        <Card>
          <Switch
            label="Round up my spending"
            description="Save the change from every naira spend"
            value={s.enabled}
            onValueChange={(enabled) => save({ enabled })}
          />
        </Card>
        {s.enabled && (
          <>
            <SelectSheet
              label="Save into"
              title="Pick a goal"
              options={open.map((g) => ({ value: g.id, label: `${g.emoji} ${g.name}` }))}
              value={s.goal_id}
              onChange={(goal_id) => save({ goal_id })}
            />
            <View style={{ gap: spacing[2] }}>
              <Text variant="label">Round up to the next</Text>
              <View accessibilityRole="radiogroup" style={[styles.chips, { gap: spacing[2] }]}>
                {STEPS.map((step) => (
                  <Chip
                    key={step.value}
                    label={step.label}
                    selected={s.round_to === step.value}
                    onPress={() => save({ round_to: step.value })}
                  />
                ))}
              </View>
              <Text variant="caption" color="textMuted">
                {roundUpExample(s.round_to)}
              </Text>
            </View>
            <Card>
              {SOURCES.map((source) => (
                <Switch
                  key={source.value}
                  label={source.label}
                  description={source.description}
                  value={s.sources.includes(source.value)}
                  onValueChange={(on) => toggleSource(source.value, on)}
                />
              ))}
            </Card>
          </>
        )}
        {update.isError && (
          <Text variant="bodySmall" color="danger" accessibilityRole="alert">
            We couldn&apos;t save that. Try again.
          </Text>
        )}
      </View>
    );
  };

  const historyList = () => {
    if (history.isError) {
      return <ErrorState title="We couldn't load round-ups" onRetry={() => history.refetch()} />;
    }
    if (!history.data) {
      return (
        <SkeletonGroup accessibilityLabel="Loading round-up history">
          <SkeletonListItem />
          <SkeletonListItem />
        </SkeletonGroup>
      );
    }
    if (history.data.data.length === 0) {
      return (
        <Text variant="bodySmall" color="textMuted">
          No round-ups yet. They show up here after your next card payment or transfer.
        </Text>
      );
    }
    return (
      <Card padded={false}>
        {history.data.data.map((t) => {
          const from = t.narration.replace(/^Round-up:\s*/, '');
          return (
            <ListItem
              key={t.id}
              leading={Coins}
              title={from}
              subtitle={formatWhen(t.created_at)}
              trailing={
                <MoneyText value={fromApiMoney(t.amount)} variant="bodyStrong" masked={hidden} />
              }
              accessibilityLabel={`Round-up from ${from}, ${hidden ? 'amount hidden' : formatMoney(fromApiMoney(t.amount))}, ${formatWhen(t.created_at)}`}
            />
          );
        })}
      </Card>
    );
  };

  return (
    <Screen
      header={<SendHeader title="Round-ups" first />}
      edges={['top', 'bottom']}
      onRefresh={() => void Promise.all([settings.refetch(), goals.refetch(), history.refetch()])}
      refreshing={settings.isRefetching || history.isRefetching}
    >
      {settingsCard()}
      <View style={{ gap: spacing[2] }}>
        <SectionHeader title="History" />
        {historyList()}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
});
