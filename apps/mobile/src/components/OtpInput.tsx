import { useState, type Ref, type ComponentRef } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { useTheme } from '@/theme';

import { sanitizeCode } from './entry';
import { FieldMessage } from './FormField';
import { Text } from './Text';

const CELL_WIDTH = 48;
const CELL_HEIGHT = 56;

export type Props = {
  value: string;
  onChangeText: (value: string) => void;
  onBlur?: () => void;
  /** Fires once the last digit is typed or a whole code is pasted. */
  onComplete?: (code: string) => void;
  /** Email OTPs are 6 digits (PRD AUTH-2). */
  length?: number;
  label?: string;
  error?: string;
  help?: string;
  autoFocus?: boolean;
  ref?: Ref<ComponentRef<typeof TextInput>>;
};

/**
 * Code entry drawn as separate cells. One invisible TextInput lies over the
 * cells, so iOS code autofill, long-press paste and screen readers all work on
 * a single real field.
 */
export function OtpInput({
  value,
  onChangeText,
  onBlur,
  onComplete,
  length = 6,
  label = 'Verification code',
  error,
  help,
  autoFocus,
  ref,
}: Props) {
  const { colors, radius, spacing } = useTheme();
  const [focused, setFocused] = useState(false);

  const handleChange = (text: string) => {
    const code = sanitizeCode(text, length);
    if (code === value) return;
    onChangeText(code);
    if (code.length === length) onComplete?.(code);
  };

  return (
    <View style={{ gap: spacing[2] }}>
      <View style={[styles.cells, { gap: spacing[2] }]}>
        {Array.from({ length }, (_, i) => {
          const active = focused && i === Math.min(value.length, length - 1);
          return (
            <View
              key={i}
              importantForAccessibility="no-hide-descendants"
              accessibilityElementsHidden
              style={[
                styles.cell,
                {
                  borderRadius: radius.md,
                  backgroundColor: colors.raised,
                  borderColor: error ? colors.danger : active ? colors.primaryText : colors.border,
                },
                (active || error) && styles.emphasis,
              ]}
            >
              <Text variant="h3">{value[i] ?? ''}</Text>
            </View>
          );
        })}
        <TextInput
          ref={ref}
          value={value}
          onChangeText={handleChange}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            onBlur?.();
          }}
          accessibilityLabel={`${label}, ${length} digits`}
          accessibilityHint={error ?? help}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          autoFocus={autoFocus}
          caretHidden
          style={[StyleSheet.absoluteFill, styles.hiddenInput]}
        />
      </View>
      <FieldMessage error={error} help={help} />
    </View>
  );
}

const styles = StyleSheet.create({
  cells: { flexDirection: 'row', justifyContent: 'center' },
  cell: {
    width: CELL_WIDTH,
    height: CELL_HEIGHT,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emphasis: { borderWidth: 2 },
  // Nearly invisible rather than fully: some platforms ignore touches on opacity 0.
  hiddenInput: { opacity: 0.02, color: 'transparent' },
});
