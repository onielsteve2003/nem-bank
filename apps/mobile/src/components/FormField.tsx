import { CircleAlert } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme';

import { Icon } from './Icon';
import { Text } from './Text';

export type FieldMessageProps = {
  error?: string;
  help?: string;
};

/** The line under a control: an error (icon + text, never colour alone) or help text. */
export function FieldMessage({ error, help }: FieldMessageProps) {
  const { spacing } = useTheme();

  if (error) {
    return (
      <View
        accessible
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        style={[styles.row, { gap: spacing[1] }]}
      >
        <Icon icon={CircleAlert} size="sm" color="danger" />
        <Text variant="caption" color="danger" style={styles.flex}>
          {error}
        </Text>
      </View>
    );
  }
  return help ? (
    <Text variant="caption" color="textMuted">
      {help}
    </Text>
  ) : null;
}

export type Props = FieldMessageProps & {
  label?: string;
  /** Adds "(optional)" to the label of fields that aren't required, so required ones stay quiet. */
  optional?: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
};

/**
 * Label, control and message for one form field. Fields take `value`/`onChange`/
 * `onBlur`/`ref` props, so they drop straight into a React Hook Form `Controller`.
 */
export function FormField({ label, optional, error, help, children, style }: Props) {
  const { spacing } = useTheme();

  return (
    <View style={[{ gap: spacing[2] }, style]}>
      {label && (
        <Text variant="label" color="textMuted">
          {label}
          {optional && ' (optional)'}
        </Text>
      )}
      {children}
      <FieldMessage error={error} help={help} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
