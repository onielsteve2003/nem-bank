import { formatMoney, money } from '@nem/shared';
import { useState } from 'react';
import { View } from 'react-native';

import {
  BarChart,
  Button,
  Card,
  DonutChart,
  LineChart,
  MoneyText,
  Text,
  type ChartDatum,
} from '@/components';
import { useTheme } from '@/theme';

import { KitSection } from './KitSection';

const RATES: ChartDatum[] = [
  { label: '10 Oct', value: 1528.4 },
  { label: '11 Oct', value: 1531.1 },
  { label: '12 Oct', value: 1526.7 },
  { label: '13 Oct', value: 1534.9 },
  { label: '14 Oct', value: 1541.2 },
  { label: '15 Oct', value: 1538.6 },
  { label: '16 Oct', value: 1545.3 },
];

// Spending in kobo; the charts plot magnitudes, labels come from exact bigint formatting.
const MONTHS: ChartDatum[] = [
  { label: 'May', value: 18_200_000 },
  { label: 'Jun', value: 21_450_000 },
  { label: 'Jul', value: 16_900_000 },
  { label: 'Aug', value: 24_300_000 },
  { label: 'Sep', value: 19_750_000 },
  { label: 'Oct', value: 14_100_000 },
];

const CATEGORIES: ChartDatum[] = [
  { label: 'Food', value: 6_250_000 },
  { label: 'Transport', value: 3_100_000 },
  { label: 'Bills', value: 2_800_000 },
  { label: 'Shopping', value: 1_450_000 },
  { label: 'Other', value: 500_000 },
];

const naira = (kobo: number) => formatMoney(money(BigInt(kobo), 'NGN'), { trimZeroMinor: true });
const rate = (v: number) => `₦${v.toFixed(2)}`;

export function ChartsSection() {
  const { spacing } = useTheme();
  const [replay, setReplay] = useState(0);
  const total = CATEGORIES.reduce((s, c) => s + BigInt(c.value), 0n);

  return (
    <KitSection title="Charts">
      <View key={replay} style={{ gap: spacing[4] }}>
        <Card>
          <Text variant="label" color="textMuted">
            USD → NGN, last 7 days
          </Text>
          <LineChart title="USD to NGN, last 7 days" data={RATES} formatValue={rate} />
        </Card>
        <Card>
          <Text variant="label" color="textMuted">
            Monthly spending
          </Text>
          <BarChart title="Monthly spending" data={MONTHS} formatValue={naira} />
        </Card>
        <Card>
          <Text variant="label" color="textMuted">
            October by category
          </Text>
          <DonutChart
            title="October spending by category"
            data={CATEGORIES}
            formatValue={naira}
            center={
              <>
                <Text variant="caption" color="textMuted">
                  Spent
                </Text>
                <MoneyText value={money(total, 'NGN')} trimZeroMinor />
              </>
            }
          />
        </Card>
      </View>
      <Button
        label="Replay animation"
        variant="ghost"
        size="sm"
        onPress={() => setReplay((n) => n + 1)}
      />
    </KitSection>
  );
}
