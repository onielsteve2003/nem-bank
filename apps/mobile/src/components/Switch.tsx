import { Pressable, Switch as NativeSwitch, StyleSheet, View } from 'react-native';

import { haptic } from '@/lib/haptics';
import { useTheme } from '@/theme';

import { Text } from './Text';

export type Props = {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
};

/**
 * A settings row with the platform switch. The whole row toggles, so the touch
 * target is the row rather than the small switch, and it is announced once.
 */
export function Switch({ label, description, value, onValueChange, disabled = false }: Props) {
  const { colors, spacing } = useTheme();

  const toggle = () => {
    haptic('selection');
    onValueChange(!value);
  };

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={description}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={toggle}
      style={[
        styles.row,
        { gap: spacing[4], paddingVertical: spacing[2] },
        disabled && styles.disabled,
      ]}
    >
      <View style={styles.flex}>
        <Text variant="bodyStrong">{label}</Text>
        {description && (
          <Text variant="bodySmall" color="textMuted">
            {description}
          </Text>
        )}
      </View>
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <NativeSwitch
          value={value}
          onValueChange={toggle}
          disabled={disabled}
          trackColor={{ false: colors.border, true: colors.primary }}
          ios_backgroundColor={colors.border}
          thumbColor={colors.surface}
        />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 52 },
  flex: { flex: 1 },
  disabled: { opacity: 0.5 },
});
