import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { ChevronRight, TrendingUp, TriangleAlert } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Card, Icon, MoneyText, Text } from '@/components';
import { fromApiMoney } from '@/lib/money';
import { useTheme } from '@/theme';

import { firstShortfall, horizon, longDate } from '../forecast';

export type Props = {
  forecast: Schema<'CashFlowForecast'>;
  hidden: boolean;
  onOpen: () => void;
};

/** The forecast in one line on Insights; the chart and the why are a tap away (INS-3). */
export function ForecastCard({ forecast, hidden, onOpen }: Props) {
  const { colors, radius, spacing } = useTheme();
  const end = horizon(forecast.points, forecast.next_payday);
  if (!end) return null;
  const short = firstShortfall(forecast.points);
  const balance = fromApiMoney(end.balance);
  const when = forecast.next_payday ? 'Before payday' : `By ${longDate(end.date)}`;
  const summary = `${when} you’ll have about ${hidden ? 'hidden' : formatMoney(balance)}.${
    short ? ` Your balance could run out around ${longDate(short.date)}.` : ''
  }`;

  return (
    <Card
      variant="outline"
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={summary}
      accessibilityHint="Opens the cash-flow forecast"
    >
      <View style={[styles.row, { gap: spacing[3] }]}>
        <View style={[styles.icon, { backgroundColor: colors.raised, borderRadius: radius.md }]}>
          <Icon
            icon={short ? TriangleAlert : TrendingUp}
            size="md"
            color={short ? 'danger' : 'primaryText'}
          />
        </View>
        <View style={[styles.flex, { gap: spacing[1] }]}>
          <Text variant="label" color="textMuted">
            {when} you’ll have about
          </Text>
          <MoneyText value={balance} variant="amount" masked={hidden} />
          <Text variant="caption" color={short ? 'danger' : 'textMuted'}>
            {short
              ? `Could run out around ${longDate(short.date)}`
              : 'Cash-flow forecast · see how'}
          </Text>
        </View>
        <Icon icon={ChevronRight} size="sm" color="textMuted" />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  icon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
});
