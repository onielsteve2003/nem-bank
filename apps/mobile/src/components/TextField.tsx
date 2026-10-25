import { MIN_TOUCH_TARGET } from '@nem/shared';
import { Eye, EyeOff, type LucideIcon } from 'lucide-react-native';
import { useState, type ReactNode, type Ref, type ComponentRef } from 'react';
import {
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';

import { useTheme } from '@/theme';

import { FormField } from './FormField';
import { Icon } from './Icon';
import { IconButton } from './IconButton';

const FIELD_HEIGHT = 52;

export type Props = Omit<TextInputProps, 'style'> & {
  label: string;
  help?: string;
  error?: string;
  optional?: boolean;
  leadingIcon?: LucideIcon;
  /** Anything to the right of the text, such as a unit or a clear button. */
  trailing?: ReactNode;
  ref?: Ref<ComponentRef<typeof TextInput>>;
  style?: StyleProp<ViewStyle>;
};

export function TextField({
  label,
  help,
  error,
  optional,
  leadingIcon,
  trailing,
  secureTextEntry,
  editable = true,
  multiline,
  onFocus,
  onBlur,
  ref,
  style,
  ...rest
}: Props) {
  const { colors, radius, spacing, type } = useTheme();
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const borderColor = error ? colors.danger : focused ? colors.primaryText : colors.border;

  return (
    <FormField label={label} optional={optional} error={error} help={help} style={style}>
      <View
        style={[
          styles.box,
          {
            minHeight: FIELD_HEIGHT,
            borderRadius: radius.md,
            borderColor,
            backgroundColor: colors.raised,
            paddingHorizontal: spacing[4],
            gap: spacing[2],
          },
          // A thicker border on focus or error, so the state isn't shown by colour alone.
          (focused || error) && styles.emphasis,
          !editable && styles.disabled,
        ]}
      >
        {leadingIcon && <Icon icon={leadingIcon} color="textMuted" />}
        <TextInput
          ref={ref}
          accessibilityLabel={label}
          accessibilityHint={error ?? help}
          accessibilityState={{ disabled: !editable }}
          placeholderTextColor={colors.textMuted}
          selectionColor={colors.primaryText}
          secureTextEntry={secureTextEntry && !revealed}
          editable={editable}
          multiline={multiline}
          maxFontSizeMultiplier={2}
          {...rest}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={[
            type.body,
            styles.input,
            { color: colors.text, paddingVertical: spacing[3] },
            multiline && styles.multiline,
          ]}
        />
        {secureTextEntry && (
          <IconButton
            icon={revealed ? EyeOff : Eye}
            accessibilityLabel={revealed ? `Hide ${label}` : `Show ${label}`}
            variant="ghost"
            size="sm"
            haptic="selection"
            onPress={() => setRevealed((r) => !r)}
          />
        )}
        {trailing}
      </View>
    </FormField>
  );
}

const styles = StyleSheet.create({
  box: { flexDirection: 'row', alignItems: 'center', borderWidth: 1 },
  emphasis: { borderWidth: 2 },
  disabled: { opacity: 0.5 },
  input: { flex: 1, minHeight: MIN_TOUCH_TARGET },
  multiline: { minHeight: 96, textAlignVertical: 'top' },
});
