import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { haptic } from '@/lib/haptics';
import { useTheme } from '@/theme';

import { isDigit, type KeypadKey } from './entry';
import { FieldMessage } from './FormField';
import { NumericKeypad, type KeypadAccessory } from './NumericKeypad';
import { Text } from './Text';
import { useShake } from './useShake';

const DOT = 16;

export type Props = {
  title: string;
  subtitle?: string;
  /** Transaction PINs are 4 digits (PRD AUTH-4). */
  length?: number;
  /**
   * Called with the full PIN. Resolve `false` to reject it: the pad shakes, buzzes
   * and clears. The parent owns attempts and lockout and shows them via `error`.
   */
  onComplete: (pin: string) => boolean | Promise<boolean>;
  error?: string;
  /** Bottom-left key, e.g. "Use Face ID". */
  accessory?: KeypadAccessory;
};

export function PinPad({ title, subtitle, length = 4, onComplete, error, accessory }: Props) {
  const { colors, spacing } = useTheme();
  const { style: shakeStyle, shake } = useShake();
  const [pin, setPin] = useState('');
  const [checking, setChecking] = useState(false);

  const submit = async (full: string) => {
    setChecking(true);
    try {
      const ok = await onComplete(full);
      if (ok) {
        haptic('success');
        return;
      }
    } catch {
      // A failed check counts as a rejection; the parent reports why through `error`.
    } finally {
      setChecking(false);
    }
    haptic('error');
    shake();
    setPin('');
  };

  const onKey = (key: KeypadKey) => {
    if (checking) return;
    if (key === 'clear') return setPin('');
    if (key === 'backspace') return setPin(pin.slice(0, -1));
    if (!isDigit(key) || pin.length >= length) return;
    const next = pin + key;
    setPin(next);
    if (next.length === length) void submit(next);
  };

  return (
    <View style={[styles.container, { gap: spacing[6] }]}>
      <View style={[styles.center, { gap: spacing[2], paddingHorizontal: spacing[6] }]}>
        <Text variant="h2" align="center">
          {title}
        </Text>
        {subtitle && (
          <Text color="textMuted" align="center">
            {subtitle}
          </Text>
        )}
      </View>
      <Animated.View
        accessible
        accessibilityLabel={`${pin.length} of ${length} digits entered`}
        style={[styles.dots, { gap: spacing[4] }, shakeStyle]}
      >
        {Array.from({ length }, (_, i) => (
          <View
            key={i}
            testID={i < pin.length ? 'pin-dot-filled' : 'pin-dot'}
            style={[
              styles.dot,
              {
                borderColor: error ? colors.danger : colors.textMuted,
                backgroundColor: i < pin.length ? colors.text : 'transparent',
              },
            ]}
          />
        ))}
      </Animated.View>
      <View style={styles.center}>
        <FieldMessage error={error} />
      </View>
      <NumericKeypad onKey={onKey} accessory={accessory} disabled={checking} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { width: '100%', alignItems: 'center' },
  center: { alignItems: 'center' },
  dots: { flexDirection: 'row' },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2, borderWidth: 2 },
});
