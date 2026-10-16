import { CURRENCIES, type CurrencyCode } from '@nem/shared';
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { haptic } from '@/lib/haptics';
import { useTheme } from '@/theme';

import { applyAmountKey, formatAmountEntry, MAX_WHOLE_DIGITS, type KeypadKey } from './entry';
import { FieldMessage } from './FormField';
import { NumericKeypad } from './NumericKeypad';
import { Text } from './Text';
import { useShake } from './useShake';

export type Props = {
  currency: CurrencyCode;
  /**
   * The typed amount in major units ("1500.5"). Kept as a string while typing so
   * "5." and "5.0" survive; convert with `parseMajor(value, currency)` on submit.
   */
  value: string;
  onChangeValue: (value: string) => void;
  label?: string;
  error?: string;
  help?: string;
  maxWholeDigits?: number;
  disabled?: boolean;
};

/** A large amount display driven by the on-screen keypad, never the system keyboard. */
export function AmountInput({
  currency,
  value,
  onChangeValue,
  label = 'Amount',
  error,
  help,
  maxWholeDigits = MAX_WHOLE_DIGITS,
  disabled = false,
}: Props) {
  const { spacing } = useTheme();
  const { symbol, minorDigits, name } = CURRENCIES[currency];
  const { style: shakeStyle, shake } = useShake();
  const shown = formatAmountEntry(value);

  const onKey = (key: KeypadKey) => {
    const next = applyAmountKey(value, key, minorDigits, maxWholeDigits);
    if (next === value && key !== 'backspace' && key !== 'clear') {
      // Ignored key (a second dot, a third decimal): say so without moving the value.
      haptic('warning');
      shake();
      return;
    }
    onChangeValue(next);
  };

  return (
    <View style={{ gap: spacing[4] }}>
      <View style={[styles.display, { gap: spacing[2], paddingHorizontal: spacing[4] }]}>
        <Animated.View style={shakeStyle}>
          <Text
            variant="amountLarge"
            color={error ? 'danger' : value === '' ? 'textMuted' : 'text'}
            align="center"
            numberOfLines={1}
            adjustsFontSizeToFit
            accessibilityLabel={`${label}: ${shown} ${name}`}
          >
            {symbol}
            {shown}
          </Text>
        </Animated.View>
        <FieldMessage error={error} help={help} />
      </View>
      <NumericKeypad onKey={onKey} decimal={minorDigits > 0} disabled={disabled} />
    </View>
  );
}

const styles = StyleSheet.create({
  display: { alignItems: 'center' },
});
