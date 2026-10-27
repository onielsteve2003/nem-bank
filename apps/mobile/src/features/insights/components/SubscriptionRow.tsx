import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { CreditCard, Repeat, TriangleAlert, Wallet } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Button, Icon, MoneyText, Text } from '@/components';
import { isOpen } from '@/features/cards/cards';
import { fromApiMoney } from '@/lib/money';
import { useTheme } from '@/theme';

import { FREQUENCY_LABEL, nextChargeLabel, type PaidWith } from '../subscriptions';

export type Props = {
  subscription: Schema<'DetectedSubscription'>;
  paidWith: PaidWith;
  today: string;
  hidden: boolean;
  onCardControls: (cardId: string) => void;
};

/** One recurring charge: what, how much, when next, and the card it hits (INS-4). */
export function SubscriptionRow({
  subscription: s,
  paidWith,
  today,
  hidden,
  onCardControls,
}: Props) {
  const { colors, radius, spacing } = useTheme();
  const amount = fromApiMoney(s.amount);
  const per = FREQUENCY_LABEL[s.frequency];
  const next = nextChargeLabel(s.next_expected_at, today);
  const warning = paidWith.kind === 'card' ? paidWith.warning : null;

  return (
    <View style={{ padding: spacing[4], gap: spacing[3] }}>
      <View
        style={[styles.row, { gap: spacing[3] }]}
        accessible
        accessibilityLabel={`${s.merchant}, ${hidden ? 'amount hidden' : formatMoney(amount)} ${per}. ${next}. ${paidWith.label}.`}
      >
        <View style={[styles.icon, { backgroundColor: colors.raised, borderRadius: radius.md }]}>
          <Icon icon={Repeat} size="md" color="primaryText" />
        </View>
        <View style={[styles.flex, { gap: spacing[1] }]}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {s.merchant}
          </Text>
          <Text variant="caption" color="textMuted">
            {next}
          </Text>
          <View style={[styles.row, { gap: spacing[1] }]}>
            <Icon
              icon={paidWith.kind === 'card' ? CreditCard : Wallet}
              size="sm"
              color="textMuted"
            />
            <Text variant="caption" color="textMuted" numberOfLines={1} style={styles.flex}>
              {paidWith.label}
            </Text>
          </View>
        </View>
        <View style={styles.end}>
          <MoneyText value={amount} variant="bodyStrong" masked={hidden} />
          <Text variant="caption" color="textMuted">
            {per}
          </Text>
        </View>
      </View>
      {warning && (
        <View style={[styles.row, { gap: spacing[2] }]} accessible accessibilityRole="alert">
          <Icon icon={TriangleAlert} size="sm" color="danger" />
          <Text variant="caption" color="danger" style={styles.flex}>
            {warning}
          </Text>
        </View>
      )}
      {paidWith.kind === 'card' && isOpen(paidWith.card) && (
        <Button
          label="Card controls"
          icon={CreditCard}
          variant="secondary"
          size="sm"
          accessibilityHint={`Freeze, limit or lock the card that pays ${s.merchant}`}
          onPress={() => onCardControls(paidWith.card.id)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  icon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
  end: { alignItems: 'flex-end' },
});
