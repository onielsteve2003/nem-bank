import { formatMoney, isZero, money } from '@nem/shared';
import { keepPreviousData } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { ChartPie } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';

import {
  Card,
  DonutChart,
  EmptyState,
  ErrorState,
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
 * Insights (INS-1..4): where the money went in a month, by category, set
 * against the month before, this month's budgets, the cash-flow forecast and
 * detected subscriptions. Spending excludes money moved between the customer's own
 * pots (savings, ajo, conversions, loan repayments).
 */
export function InsightsScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
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
    body = <ErrorState title="We couldn't load your spending" onRetry={() => q.refetch()} />;
  } else if (!s || !latest) {
    body = (
      <SkeletonGroup accessibilityLabel="Loading your spending">
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
        ? `${formatMoney(money(change.minor, total.currency))} ${change.kind} than ${prev}`
        : !isZero(before)
          ? `${prev} in all: ${formatMoney(before)}`
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
            title={`Nothing spent in ${monthLabel(s.month)}${inProgress ? ' yet' : ''}`}
            message="Card payments, bills and transfers to other people show up here."
          />
        ) : (
          <>
            <Card>
              <View style={{ gap: spacing[3] }}>
                <View style={{ gap: spacing[1] }}>
                  <Text variant="bodySmall" color="textMuted">
                    {inProgress ? `Spent in ${monthLabel(s.month)} so far` : 'You spent'}
                  </Text>
                  <MoneyText value={total} variant="amountLarge" masked={hidden} />
                  {compare && (
                    <Text variant="caption" color="textMuted">
                      {compare}
                    </Text>
                  )}
                </View>
                <DonutChart
                  title={`Spending by category in ${monthLabel(s.month)}`}
                  data={slices.map((d) => ({ label: d.label, value: Number(d.minor) }))}
                  formatValue={(_, i) =>
                    hidden ? `₦${MASK}` : formatMoney(money(slices[i]!.minor, total.currency))
                  }
                  center={
                    <Text variant="caption" color="textMuted">
                      {s.categories.length} {s.categories.length === 1 ? 'category' : 'categories'}
                    </Text>
                  }
                />
              </View>
            </Card>
            <View style={{ gap: spacing[2] }}>
              <SectionHeader title={`Compared with ${prev}`} />
              <CategoryCompare
                categories={s.categories}
                month={s.month}
                inProgress={inProgress}
                hidden={hidden}
              />
              {inProgress && (
                <Text variant="caption" color="textMuted">
                  The month isn’t over, so a category only shows as up once it passes {prev}.
                </Text>
              )}
            </View>
          </>
        )}
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
      header={<SendHeader title="Insights" first />}
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
