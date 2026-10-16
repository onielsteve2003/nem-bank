import { MIN_TOUCH_TARGET } from '@nem/shared';
import { Check } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';

import { haptic } from '@/lib/haptics';
import { useTheme } from '@/theme';

import { FieldMessage } from './FormField';
import { Icon } from './Icon';
import { Text } from './Text';

const BOX = 24;

export type Props = {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  error?: string;
  help?: string;
  disabled?: boolean;
};

export function Checkbox({ label, checked, onChange, error, help, disabled = false }: Props) {
  const { colors, radius, spacing } = useTheme();

  return (
    <View style={{ gap: spacing[1] }}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel={label}
        accessibilityHint={error}
        accessibilityState={{ checked, disabled }}
        disabled={disabled}
        onPress={() => {
          haptic('selection');
          onChange(!checked);
        }}
        style={[styles.row, { gap: spacing[3] }, disabled && styles.disabled]}
      >
        <View
          style={[
            styles.box,
            {
              borderRadius: radius.sm / 2,
              borderColor: error ? colors.danger : checked ? colors.primary : colors.textMuted,
              backgroundColor: checked ? colors.primary : 'transparent',
            },
          ]}
        >
          {checked && <Icon icon={Check} size="sm" color="onPrimary" strokeWidth={3} />}
        </View>
        <Text style={styles.flex}>{label}</Text>
      </Pressable>
      <FieldMessage error={error} help={help} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: MIN_TOUCH_TARGET },
  box: {
    width: BOX,
    height: BOX,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flex: { flex: 1 },
  disabled: { opacity: 0.5 },
});
