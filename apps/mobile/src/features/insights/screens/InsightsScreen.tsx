import { formatMoney, isZero, money } from '@nem/shared';
import { keepPreviousData } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { ChartPie, Sparkles } from '@/components/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  Card,
  DonutChart,
  EmptyState,
  ErrorState,
  ListItem,
  MoneyText,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
} from '@/components';
import { MASK } from '@/components/MoneyText';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { fromApiMoney } from '@/lib/money';
import { useRepoQuery } from '@/lib/query';
import { useBalancesHidden } from '@/stores';
import { useTheme } from '@/theme';

import { BudgetsSummary } from '../components/BudgetsSummary';
import { CategoryCompare } from '../components/CategoryCompare';
import { ForecastCard } from '../components/ForecastCard';
import { MonthStepper } from '../components/MonthStepper';
import { SubscriptionsCard } from '../components/SubscriptionsCard';
import { changeOf, donutSlices, monthLabel, MONTHS_BACK, shiftMonth } from '../insights';

/**
 * Insights (INS-1..5): where the money went in a month, by category, set
 * against the month before, this month's budgets, the cash-flow forecast and
 * detected subscriptions, with the way into the Money Story. Spending excludes money moved between the customer's own
 * pots (savings, ajo, conversions, loan repayments).
 */
export function InsightsScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const hidden = useBalancesHidden();
  // null = the current month, whatever the bank's clock says it is.
  const [picked, setPicked] = useState<string | null>(null);
  const current = useRepoQuery('insights', 'getSpending', { query: { currency: 'NGN' } });
  const latest = current.data?.month;
  const other = useRepoQuery(
    'insights',
    'getSpending',
    { query: { currency: 'NGN', month: picked ?? undefined } },
    { enabled: picked !== null, placeholderData: keepPreviousData },
  );
  const budgets = useRepoQuery('insights', 'listBudgets');
  const forecast = useRepoQuery('insights', 'getForecast');
  const subscriptions = useRepoQuery('insights', 'listSubscriptions');
  const q = picked === null ? current : other;
  const s = q.data;

  let body;
  if (q.isError && !s) {
    body = <ErrorState title={t('insights.home.failed')} onRetry={() => q.refetch()} />;
  } else if (!s || !latest) {
    body = (
      <SkeletonGroup accessibilityLabel={t('insights.home.loading')}>
        <Skeleton height={44} />
        <Skeleton height={320} />
        <Skeleton height={200} />
      </SkeletonGroup>
    );
  } else {
    const inProgress = s.month === latest;
    const total = fromApiMoney(s.total);
    const before = fromApiMoney(s.previous_total);
    const prev = monthLabel(shiftMonth(s.month, -1));
    const change = changeOf(total.amount, before.amount, inProgress);
    const slices = donutSlices(s.categories);
    const compare = hidden
      ? null
      : change.kind === 'more' || change.kind === 'less'
        ? t(`insights.home.${change.kind}`, {
            amount: formatMoney(money(change.minor, total.currency)),
            month: prev,
          })
        : !isZero(before)
          ? t('insights.home.inAll', { month: prev, amount: formatMoney(before) })
          : null;

    body = (
      <>
        <MonthStepper
          month={s.month}
          latest={latest}
          earliest={shiftMonth(latest, -MONTHS_BACK)}
          onChange={(m) => setPicked(m === latest ? null : m)}
        />
        {isZero(total) ? (
          <EmptyState
            icon={ChartPie}
            title={t(inProgress ? 'insights.home.nothingYet' : 'insights.home.nothing', {
              month: monthLabel(s.month),
            })}
            message={t('insights.home.nothingMessage')}
          />
        ) : (
          <>
            <Card>
              <View style={{ gap: spacing[3] }}>
                <View style={{ gap: spacing[1] }}>
                  <Text variant="bodySmall" color="textMuted">
                    {inProgress
                      ? t('insights.home.soFar', { month: monthLabel(s.month) })
                      : t('insights.home.youSpent')}
                  </Text>
                  <MoneyText value={total} variant="amountLarge" masked={hidden} />
                  {compare && (
                    <Text variant="caption" color="textMuted">
                      {compare}
                    </Text>
                  )}
                </View>
                <DonutChart
                  title={t('insights.home.donut', { month: monthLabel(s.month) })}
                  data={slices.map((d) => ({ label: d.label, value: Number(d.minor) }))}
                  formatValue={(_, i) =>
                    hidden ? `₦${MASK}` : formatMoney(money(slices[i]!.minor, total.currency))
                  }
                  center={
                    <Text variant="caption" color="textMuted">
                      {t('insights.home.categories', { count: s.categories.length })}
                    </Text>
                  }
                />
              </View>
            </Card>
            <View style={{ gap: spacing[2] }}>
              <SectionHeader title={t('insights.compare.withMonth', { month: prev })} />
              <CategoryCompare
                categories={s.categories}
                month={s.month}
                inProgress={inProgress}
                hidden={hidden}
              />
              {inProgress && (
                <Text variant="caption" color="textMuted">
                  {t('insights.home.notOver', { month: prev })}
                </Text>
              )}
            </View>
          </>
        )}
        {/* The story is for a finished month: last month while this one runs. */}
        <Card padded={false}>
          <ListItem
            leading={Sparkles}
            title={t('insights.home.storyTitle', {
              month: monthLabel(inProgress ? shiftMonth(s.month, -1) : s.month),
            })}
            subtitle={t('insights.home.storySubtitle')}
            onPress={() =>
              router.push({
                pathname: '/insights/story',
                params: { month: inProgress ? shiftMonth(s.month, -1) : s.month },
              })
            }
          />
        </Card>
        {inProgress && forecast.data && (
          <ForecastCard
            forecast={forecast.data}
            hidden={hidden}
            onOpen={() => router.push('/insights/forecast')}
          />
        )}
        {inProgress && subscriptions.data && (
          <SubscriptionsCard
            list={subscriptions.data}
            hidden={hidden}
            onOpen={() => router.push('/insights/subscriptions')}
          />
        )}
        {inProgress && budgets.data && (
          <BudgetsSummary
            budgets={budgets.data.data}
            hidden={hidden}
            onManage={() => router.push('/insights/budgets')}
          />
        )}
      </>
    );
  }

  return (
    <Screen
      header={<SendHeader title={t('insights.title')} first />}
      edges={['top', 'bottom']}
      onRefresh={() =>
        void Promise.all([
          q.refetch(),
          budgets.refetch(),
          forecast.refetch(),
          subscriptions.refetch(),
        ])
      }
      refreshing={q.isRefetching}
    >
      {body}
    </Screen>
  );
}
