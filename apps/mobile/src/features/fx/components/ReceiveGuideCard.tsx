import type { CurrencyCode } from '@nem/shared';
import { StyleSheet, View } from 'react-native';

import { Card, Text } from '@/components';
import { useTheme } from '@/theme';

import { receiveSteps, type ReceiveGuide } from '../receive';

export type Props = { currency: CurrencyCode; guide: ReceiveGuide };

/** How a payment from abroad gets here (FX-3): numbered steps, then the facts that matter. */
export function ReceiveGuideCard({ currency, guide }: Props) {
  const { colors, spacing, radius } = useTheme();
  const facts = [
    { label: 'Sent by', value: guide.rail },
    { label: 'Usually takes', value: guide.speed },
    { label: 'Who pays this way', value: guide.payers },
    { label: 'Fees', value: 'Free to receive. Their bank may charge to send.' },
  ];

  return (
    <Card style={{ gap: spacing[4] }}>
      <View style={{ gap: spacing[3] }} accessibilityRole="list">
        {receiveSteps(currency, guide).map((step, i) => (
          <View
            key={step}
            style={[styles.row, { gap: spacing[3] }]}
            accessible
            accessibilityLabel={`Step ${i + 1}: ${step}`}
          >
            <View
              style={[styles.badge, { borderRadius: radius.pill, backgroundColor: colors.raised }]}
            >
              <Text variant="label" color="primaryText">
                {i + 1}
              </Text>
            </View>
            <Text style={styles.flex}>{step}</Text>
          </View>
        ))}
      </View>
      <View style={{ gap: spacing[2] }}>
        {facts.map((fact) => (
          <View key={fact.label} accessible accessibilityLabel={`${fact.label}: ${fact.value}`}>
            <Text variant="caption" color="textMuted">
              {fact.label}
            </Text>
            <Text variant="bodySmall">{fact.value}</Text>
          </View>
        ))}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  flex: { flex: 1 },
  badge: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
});
