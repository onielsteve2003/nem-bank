import { Delete, type LucideIcon } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { haptic } from '@/lib/haptics';
import { useTheme } from '@/theme';

import type { KeypadKey } from './entry';
import { Icon } from './Icon';
import { PressableScale } from './PressableScale';
import { Text } from './Text';

const KEY_HEIGHT = 60;
const ROWS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
] as const;

export type KeypadAccessory = {
  icon: LucideIcon;
  accessibilityLabel: string;
  onPress: () => void;
};

export type Props = {
  onKey: (key: KeypadKey) => void;
  /** Shows a decimal point key bottom-left (amounts). */
  decimal?: boolean;
  /** Bottom-left action when there is no decimal key, such as Face ID on a PIN pad. */
  accessory?: KeypadAccessory;
  disabled?: boolean;
};

/** An on-screen number pad. Money and PIN entry use it instead of the system keyboard. */
export function NumericKeypad({ onKey, decimal = false, accessory, disabled = false }: Props) {
  const { spacing } = useTheme();

  const press = (key: KeypadKey) => {
    haptic('tap');
    onKey(key);
  };

  const keyProps = { disabled, style: [styles.key, { margin: spacing[1] }] };

  let bottomLeft = <View style={[styles.key, { margin: spacing[1] }]} />;
  if (decimal) {
    bottomLeft = (
      <PressableScale
        {...keyProps}
        accessibilityRole="button"
        accessibilityLabel="Decimal point"
        onPress={() => press('.')}
      >
        <Text variant="h2">.</Text>
      </PressableScale>
    );
  } else if (accessory) {
    bottomLeft = (
      <PressableScale
        {...keyProps}
        accessibilityRole="button"
        accessibilityLabel={accessory.accessibilityLabel}
        onPress={() => {
          haptic('tap');
          accessory.onPress();
        }}
      >
        <Icon icon={accessory.icon} size="lg" />
      </PressableScale>
    );
  }

  return (
    <View style={styles.pad}>
      {ROWS.map((row) => (
        <View key={row[0]} style={styles.row}>
          {row.map((digit) => (
            <PressableScale
              key={digit}
              {...keyProps}
              accessibilityRole="button"
              accessibilityLabel={digit}
              onPress={() => press(digit)}
            >
              <Text variant="h2">{digit}</Text>
            </PressableScale>
          ))}
        </View>
      ))}
      <View style={styles.row}>
        {bottomLeft}
        <PressableScale
          {...keyProps}
          accessibilityRole="button"
          accessibilityLabel="0"
          onPress={() => press('0')}
        >
          <Text variant="h2">0</Text>
        </PressableScale>
        <PressableScale
          {...keyProps}
          accessibilityRole="button"
          accessibilityLabel="Delete"
          accessibilityHint="Hold to clear everything"
          onPress={() => press('backspace')}
          onLongPress={() => {
            haptic('warning');
            onKey('clear');
          }}
        >
          <Icon icon={Delete} size="lg" />
        </PressableScale>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { width: '100%' },
  row: { flexDirection: 'row' },
  key: { flex: 1, height: KEY_HEIGHT, alignItems: 'center', justifyContent: 'center' },
});
