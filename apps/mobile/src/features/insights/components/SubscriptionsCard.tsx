import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { ChevronRight, Repeat } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Card, Icon, MoneyText, Text } from '@/components';
import { fromApiMoney } from '@/lib/money';
import { useTheme } from '@/theme';

export type Props = {
  list: Schema<'SubscriptionList'>;
  hidden: boolean;
  onOpen: () => void;
};

/** Subscriptions in one line on Insights; the list and card links are a tap away (INS-4). */
export function SubscriptionsCard({ list, hidden, onOpen }: Props) {
  const { colors, radius, spacing } = useTheme();
  if (list.data.length === 0) return null;
  const count = `${list.data.length} ${list.data.length === 1 ? 'subscription' : 'subscriptions'}`;
  const total = fromApiMoney(list.monthly_total);
  const next = list.data[0]!;

  return (
    <Card
      variant="outline"
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`${count}, ${hidden ? 'amount hidden' : formatMoney(total)} a month. Next: ${next.merchant}.`}
      accessibilityHint="Opens your subscriptions"
    >
      <View style={[styles.row, { gap: spacing[3] }]}>
        <View style={[styles.icon, { backgroundColor: colors.raised, borderRadius: radius.md }]}>
          <Icon icon={Repeat} size="md" color="primaryText" />
        </View>
        <View style={[styles.flex, { gap: spacing[1] }]}>
          <Text variant="label" color="textMuted">
            {count} a month
          </Text>
          <MoneyText value={total} variant="amount" masked={hidden} />
          <Text variant="caption" color="textMuted" numberOfLines={1}>
            Next: {next.merchant} · card controls inside
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
