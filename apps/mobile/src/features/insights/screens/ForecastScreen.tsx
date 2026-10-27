import { formatMoney, negate } from '@nem/shared';
import { TriangleAlert } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import {
  AIBadge,
  Card,
  Divider,
  ErrorState,
  Icon,
  LineChart,
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
import { useBalancesHidden, usePreferencesStore } from '@/stores';
import { useTheme } from '@/theme';

import { firstShortfall, horizon, longDate, shortDate } from '../forecast';

const SIMPLE_FORECAST =
  'Simple forecast: your average daily spending over the last 90 days, plus your salary and the subscriptions you already pay.';

/**
 * Cash-flow forecast (INS-3, AI-4): the naira balance day by day to payday,
 * the range it will likely land in, what is expected in and out, and a plain
 * explanation of how it was worked out.
 */
export function ForecastScreen() {
  const { spacing } = useTheme();
  const hidden = useBalancesHidden();
  const aiOn = usePreferencesStore((s) => s.ai.forecast);
  const q = useRepoQuery('insights', 'getForecast');
  const f = q.data;

  let body;
  if (q.isError && !f) {
    body = <ErrorState title="We couldn't work out your forecast" onRetry={() => q.refetch()} />;
  } else if (!f) {
    body = (
      <SkeletonGroup accessibilityLabel="Working out your forecast">
        <Skeleton height={120} />
        <Skeleton height={200} />
      </SkeletonGroup>
    );
  } else {
    const end = horizon(f.points, f.next_payday);
    const short = firstShortfall(f.points);
    const fmt = (i: number) =>
      hidden ? `₦${MASK}` : formatMoney(fromApiMoney(f.points[i]!.balance));
    body = (
      <>
        <Card>
          <View style={{ gap: spacing[3] }}>
            {aiOn ? (
              <View style={styles.start}>
                <AIBadge
                  feature="Cash-flow forecast"
                  explanation={f.ai.explanation}
                  fallback={SIMPLE_FORECAST}
                />
              </View>
            ) : (
              <Text variant="caption" color="textMuted">
                AI forecast is off · simple average
              </Text>
            )}
            {end && (
              <View style={{ gap: spacing[1] }}>
                <Text variant="bodySmall" color="textMuted">
                  {f.next_payday
                    ? `The day before payday (${longDate(f.next_payday)}) you’ll have about`
                    : `On ${longDate(end.date)} you’ll have about`}
                </Text>
                <MoneyText
                  value={fromApiMoney(end.balance)}
                  variant="amountLarge"
                  masked={hidden}
                  label="Forecast balance"
                />
                {!hidden && (
                  <Text variant="caption" color="textMuted">
                    Likely between {formatMoney(fromApiMoney(end.low))} and{' '}
                    {formatMoney(fromApiMoney(end.high))}
                  </Text>
                )}
              </View>
            )}
            <LineChart
              title="Forecast naira balance, day by day"
              data={f.points.map((p) => ({
                label: shortDate(p.date),
                value: Number(BigInt(p.balance.amount_minor) / 100n),
              }))}
              formatValue={(_, i) => fmt(i)}
              color={short ? 'danger' : 'primaryText'}
            />
          </View>
        </Card>

        {short && (
          <Card variant="outline">
            <View style={[styles.row, { gap: spacing[3] }]} accessible accessibilityRole="alert">
              <Icon icon={TriangleAlert} color="danger" />
              <Text variant="body" style={styles.flex}>
                At this pace your balance could run out around {longDate(short.date)}. Setting a
                budget or moving a payment can help.
              </Text>
            </View>
          </Card>
        )}

        <View style={{ gap: spacing[2] }}>
          <SectionHeader title="How we worked it out" />
          <Card>
            <Text variant="body">{f.explanation}</Text>
          </Card>
        </View>

        {f.upcoming.length > 0 && (
          <View style={{ gap: spacing[2] }}>
            <SectionHeader title="Expected before then" />
            <Card padded={false}>
              <View accessibilityRole="list">
                {f.upcoming.map((u, i) => {
                  const amount = fromApiMoney(u.amount);
                  return (
                    <View key={`${u.label}-${u.date}`}>
                      {i > 0 && <Divider />}
                      <View style={[styles.row, { gap: spacing[3], padding: spacing[4] }]}>
                        <View style={[styles.flex, { gap: spacing[1] }]}>
                          <Text variant="bodyStrong">{u.label}</Text>
                          <Text variant="caption" color="textMuted">
                            {longDate(u.date)}
                          </Text>
                        </View>
                        <MoneyText
                          value={u.direction === 'credit' ? amount : negate(amount)}
                          variant="bodyStrong"
                          colorBySign
                          signPositive
                          masked={hidden}
                          label={u.direction === 'credit' ? 'Coming in' : 'Going out'}
                        />
                      </View>
                    </View>
                  );
                })}
              </View>
            </Card>
          </View>
        )}
        <Text variant="caption" color="textMuted">
          A forecast, not a promise: it assumes you keep spending the way you have been.
        </Text>
      </>
    );
  }

  return (
    <Screen
      header={<SendHeader title="Cash-flow forecast" />}
      edges={['top', 'bottom']}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      {body}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  start: { alignItems: 'flex-start' },
});
