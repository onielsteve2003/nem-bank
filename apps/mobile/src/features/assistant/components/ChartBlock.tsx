import type { Schema } from '@nem/contracts';
import { CURRENCIES, formatMoney } from '@nem/shared';
import { StyleSheet, View } from 'react-native';

import { BarChart, DonutChart, LineChart, Text } from '@/components';
import { MASK } from '@/components/MoneyText';
import { fromApiMoney } from '@/lib/money';
import { usePrivacyStore } from '@/stores';
import { useTheme } from '@/theme';

type Props = { block: Schema<'AssistantChartBlock'> };

/** A chart the assistant drew from your data; amounts follow Hide balances. */
export function ChartBlock({ block }: Props) {
  const { colors, radius, spacing } = useTheme();
  const hidden = usePrivacyStore((s) => s.balancesHidden);
  const amounts = block.series.map((d) => fromApiMoney(d.amount));
  // Charts take plain numbers; minor units stay exact for any real balance.
  const data = block.series.map((d, i) => ({ label: d.label, value: Number(amounts[i]!.amount) }));
  const formatValue = (_: number, i: number) => {
    const m = amounts[i]!;
    return hidden ? `${CURRENCIES[m.currency].symbol}${MASK}` : formatMoney(m);
  };

  if (data.length === 0) {
    return (
      <Text variant="bodySmall" color="textMuted">
        {block.title}: nothing to show yet.
      </Text>
    );
  }

  return (
    <View
      style={[
        styles.box,
        {
          borderColor: colors.border,
          borderRadius: radius.md,
          padding: spacing[3],
          gap: spacing[2],
        },
      ]}
    >
      <Text variant="bodyStrong">{block.title}</Text>
      {block.chart === 'donut' ? (
        <DonutChart title={block.title} data={data} formatValue={formatValue} size={150} />
      ) : block.chart === 'bar' ? (
        <BarChart title={block.title} data={data} formatValue={formatValue} height={140} />
      ) : (
        <LineChart title={block.title} data={data} formatValue={formatValue} height={140} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: StyleSheet.hairlineWidth },
});
