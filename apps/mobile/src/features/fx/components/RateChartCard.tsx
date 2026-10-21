import type { Schema } from '@nem/contracts';
import { keepPreviousData } from '@tanstack/react-query';
import { Minus, TrendingDown, TrendingUp } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Card,
  Chip,
  ErrorState,
  Icon,
  LineChart,
  Skeleton,
  SkeletonGroup,
  Text,
} from '@/components';
import { useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { chartData, nairaRate, pairLabel, RANGES, rateChange } from '../rates';

type Range = Schema<'FxRateHistory'>['range'];

export type Props = {
  pair: string;
  /** Today's mid-market rate for the pair, from the rates list. */
  rate: Schema<'FxRate'> | undefined;
};

const TREND = {
  up: { icon: TrendingUp, color: 'success', word: 'up' },
  down: { icon: TrendingDown, color: 'danger', word: 'down' },
  flat: { icon: Minus, color: 'textMuted', word: 'flat' },
} as const;

/**
 * A pair's mid-market rate over 1D/1W/1M/1Y (FX-2), with how far it moved.
 * Naira weakening shows as the rate going up; the arrow and the word say so,
 * never the colour alone.
 */
export function RateChartCard({ pair, rate }: Props) {
  const { spacing } = useTheme();
  const [range, setRange] = useState<Range>('1W');
  const history = useRepoQuery(
    'fx',
    'getRateHistory',
    { path: { pair }, query: { range } },
    { placeholderData: keepPreviousData },
  );
  const change = history.data ? rateChange(history.data.points) : null;
  const spoken = RANGES.find((r) => r.range === range)!.spoken;
  const trend = change ? TREND[change.direction] : null;

  return (
    <Card>
      <View style={{ gap: spacing[3] }}>
        <View style={{ gap: spacing[1] }}>
          <Text variant="caption" color="textMuted">
            {pairLabel(pair)} · mid-market
          </Text>
          {rate ? (
            <Text
              variant="display"
              accessibilityLabel={`${pairLabel(pair)} is ${nairaRate(pair, rate.mid_rate)}`}
            >
              {nairaRate(pair, rate.mid_rate)}
            </Text>
          ) : (
            <Skeleton height={36} width={180} />
          )}
          {change && trend && (
            <View
              style={[styles.row, { gap: spacing[1] }]}
              accessible
              accessibilityLabel={`${trend.word} ${change.label} over the ${spoken}`}
            >
              <Icon icon={trend.icon} size="sm" color={trend.color} />
              <Text variant="bodySmall" color={trend.color}>
                {change.label}
              </Text>
              <Text variant="bodySmall" color="textMuted">
                {spoken}
              </Text>
            </View>
          )}
        </View>

        {history.data ? (
          <View style={{ opacity: history.isPlaceholderData ? 0.5 : 1 }}>
            <LineChart
              title={`${pairLabel(pair)}, ${spoken}`}
              data={chartData(history.data)}
              formatValue={(v) => `₦${v.toFixed(2)}`}
            />
          </View>
        ) : history.isError ? (
          <ErrorState title="We couldn't load the chart" onRetry={() => history.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel="Loading the chart">
            <Skeleton height={160} />
          </SkeletonGroup>
        )}

        <View style={[styles.row, styles.ranges]} accessibilityRole="tablist">
          {RANGES.map((r) => (
            <Chip
              key={r.range}
              label={r.label}
              selected={r.range === range}
              onPress={() => setRange(r.range)}
            />
          ))}
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  ranges: { justifyContent: 'space-between' },
});
