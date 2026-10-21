import type { Schema } from '@nem/contracts';
import { CheckCircle2 } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Button, Icon, MoneyText, Screen, Text } from '@/components';
import { fromApiMoney } from '@/lib/money';
import { useTheme } from '@/theme';

import { rateLine } from '../quote';

export type Props = {
  conversion: Schema<'FxConversion'>;
  onDone: () => void;
  onAgain: () => void;
};

/** The conversion went through: what left, what landed and the rate it used. */
export function ConvertDone({ conversion, onDone, onAgain }: Props) {
  const { spacing } = useTheme();
  const sell = fromApiMoney(conversion.sell);
  const buy = fromApiMoney(conversion.buy);
  return (
    <Screen
      edges={['top', 'bottom']}
      footer={
        <View style={{ gap: spacing[2] }}>
          <Button label="Done" onPress={onDone} />
          <Button label="Convert again" variant="secondary" onPress={onAgain} />
        </View>
      }
    >
      <View
        style={[styles.center, { gap: spacing[3], paddingTop: spacing[10] }]}
        accessibilityLiveRegion="polite"
      >
        <Icon icon={CheckCircle2} size="xl" color="success" accessibilityLabel="Done" />
        <Text variant="title" accessibilityRole="header">
          Converted
        </Text>
        <MoneyText value={buy} variant="display" label="Received" align="center" />
        <View style={[styles.row, { gap: spacing[1] }]}>
          <Text color="textMuted">From</Text>
          <MoneyText value={sell} color="textMuted" label="Converted" />
        </View>
        <Text variant="bodySmall" color="textMuted">
          At {rateLine(conversion.rate, sell.currency, buy.currency)}. Now in your wallet.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center' },
});
