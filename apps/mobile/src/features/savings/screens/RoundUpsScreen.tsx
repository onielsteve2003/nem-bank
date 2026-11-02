import type { Schema } from '@nem/contracts';
import { formatMoney, money } from '@nem/shared';
import { useRouter } from 'expo-router';
import { Coins } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
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
import i18n from '@/lib/i18n';
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
/** Words are read in the current language on access. */
const SOURCES = (['card', 'transfer'] as const satisfies readonly Source[]).map((value) => ({
  value,
  get label() {
    return i18n.t(`savings.roundUps.sources.${value}.label`);
  },
  get description() {
    return i18n.t(`savings.roundUps.sources.${value}.description`);
  },
}));
const EXAMPLE_SPEND = 123_000n;
const HISTORY = 20;

/** What a ₦1,230 spend would put away at this step, as an example. */
export function roundUpExample(step: Settings['round_to']): string {
  const s = BigInt(step);
  const rest = EXAMPLE_SPEND % s;
  return i18n.t('savings.roundUps.example', {
    spend: formatMoney(money(EXAMPLE_SPEND, 'NGN')),
    saved: formatMoney(money(rest === 0n ? 0n : s - rest, 'NGN')),
  });
}

/**
 * Round-ups (SAV-3): naira card and transfer spends are rounded up to the next
 * ₦100, ₦500 or ₦1,000 and the change goes into one goal. Every change saves
 * straight away; the history lists each round-up made.
 */
export function RoundUpsScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { t } = useTranslation();
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
          title={t('savings.roundUps.failed')}
          onRetry={() => void Promise.all([settings.refetch(), goals.refetch()])}
        />
      );
    }
    if (!s || !goals.data) {
      return (
        <SkeletonGroup accessibilityLabel={t('savings.roundUps.loading')}>
          <Skeleton height={220} />
        </SkeletonGroup>
      );
    }
    if (open.length === 0) {
      return (
        <EmptyState
          icon={Coins}
          title={t('savings.roundUps.needGoalTitle')}
          message={t('savings.roundUps.needGoalMessage')}
          actionLabel={t('savings.grow.startGoal')}
          onAction={() => router.push('/goals/new')}
        />
      );
    }
    return (
      <View style={{ gap: spacing[4] }}>
        <Card>
          <Switch
            label={t('savings.roundUps.toggle')}
            description={t('savings.roundUps.toggleHelp')}
            value={s.enabled}
            onValueChange={(enabled) => save({ enabled })}
          />
        </Card>
        {s.enabled && (
          <>
            <SelectSheet
              label={t('savings.roundUps.saveInto')}
              title={t('savings.roundUps.pickGoal')}
              options={open.map((g) => ({ value: g.id, label: `${g.emoji} ${g.name}` }))}
              value={s.goal_id}
              onChange={(goal_id) => save({ goal_id })}
            />
            <View style={{ gap: spacing[2] }}>
              <Text variant="label">{t('savings.roundUps.roundTo')}</Text>
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
            {t('common.saveFailedGeneric')}
          </Text>
        )}
      </View>
    );
  };

  const historyList = () => {
    if (history.isError) {
      return (
        <ErrorState title={t('savings.roundUps.historyFailed')} onRetry={() => history.refetch()} />
      );
    }
    if (!history.data) {
      return (
        <SkeletonGroup accessibilityLabel={t('savings.roundUps.historyLoading')}>
          <SkeletonListItem />
          <SkeletonListItem />
        </SkeletonGroup>
      );
    }
    if (history.data.data.length === 0) {
      return (
        <Text variant="bodySmall" color="textMuted">
          {t('savings.roundUps.historyEmpty')}
        </Text>
      );
    }
    return (
      <Card padded={false}>
        {history.data.data.map((tx) => {
          const from = tx.narration.replace(/^Round-up:\s*/, '');
          return (
            <ListItem
              key={tx.id}
              leading={Coins}
              title={from}
              subtitle={formatWhen(tx.created_at)}
              trailing={
                <MoneyText value={fromApiMoney(tx.amount)} variant="bodyStrong" masked={hidden} />
              }
              accessibilityLabel={t('savings.roundUps.rowLabel', {
                from,
                amount: hidden
                  ? t('savings.roundUps.amountHidden')
                  : formatMoney(fromApiMoney(tx.amount)),
                when: formatWhen(tx.created_at),
              })}
            />
          );
        })}
      </Card>
    );
  };

  return (
    <Screen
      header={<SendHeader title={t('savings.roundUps.title')} first />}
      edges={['top', 'bottom']}
      onRefresh={() => void Promise.all([settings.refetch(), goals.refetch(), history.refetch()])}
      refreshing={settings.isRefetching || history.isRefetching}
    >
      {settingsCard()}
      <View style={{ gap: spacing[2] }}>
        <SectionHeader title={t('savings.roundUps.history')} />
        {historyList()}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
});
