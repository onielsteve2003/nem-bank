import { MIN_TOUCH_TARGET, type ColorTokens } from '@nem/shared';
import type { LucideIcon } from 'lucide-react-native';
import {
  ActivityIndicator,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { haptic, type HapticKind } from '@/lib/haptics';
import { useTheme } from '@/theme';

import { Icon } from './Icon';
import { PressableScale } from './PressableScale';
import { Text } from './Text';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

type Palette = {
  fill: keyof ColorTokens | null;
  fg: keyof ColorTokens;
  border?: keyof ColorTokens;
};

export const BUTTON_PALETTE: Record<ButtonVariant, Palette> = {
  primary: { fill: 'primary', fg: 'onPrimary' },
  secondary: { fill: 'raised', fg: 'text', border: 'border' },
  ghost: { fill: null, fg: 'primaryText' },
  danger: { fill: 'danger', fg: 'onStatus' },
};

const HEIGHT: Record<ButtonSize, number> = { sm: 36, md: 48, lg: 56 };

/** Grows the touch area of anything drawn smaller than 44 pt (code-standards §7). */
export function touchSlop(size: number) {
  const extra = Math.max(0, (MIN_TOUCH_TARGET - size) / 2);
  return extra > 0 ? { top: extra, bottom: extra, left: extra, right: extra } : undefined;
}

export type Props = Omit<PressableProps, 'children' | 'style'> & {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, blocks presses and tells screen readers the button is busy. */
  loading?: boolean;
  icon?: LucideIcon;
  iconPosition?: 'leading' | 'trailing';
  fullWidth?: boolean;
  /** Haptic played on press; `false` for none. Danger buttons default to a warning buzz. */
  haptic?: HapticKind | false;
  style?: StyleProp<ViewStyle>;
};

export function Button({
  label,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  icon,
  iconPosition = 'leading',
  fullWidth = false,
  haptic: hapticKind = variant === 'danger' ? 'warning' : 'tap',
  onPress,
  style,
  accessibilityLabel,
  ...rest
}: Props) {
  const { colors, radius, spacing } = useTheme();
  const palette = BUTTON_PALETTE[variant];
  const inactive = Boolean(disabled) || loading;
  const height = HEIGHT[size];

  const handlePress = (e: GestureResponderEvent) => {
    if (hapticKind) haptic(hapticKind);
    onPress?.(e);
  };

  const glyph = icon ? (
    <Icon icon={icon} size={size === 'sm' ? 'sm' : 'md'} color={palette.fg} />
  ) : null;

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      hitSlop={touchSlop(height)}
      {...rest}
      disabled={inactive}
      onPress={handlePress}
      style={[
        styles.base,
        {
          minHeight: height,
          paddingHorizontal: size === 'sm' ? spacing[3] : spacing[5],
          borderRadius: radius.pill,
          backgroundColor: palette.fill ? colors[palette.fill] : 'transparent',
          borderColor: palette.border ? colors[palette.border] : 'transparent',
        },
        fullWidth && styles.fullWidth,
        disabled && styles.disabled,
        style,
      ]}
    >
      {/* The label stays laid out while loading so the button never changes width. */}
      <View style={[styles.content, { gap: spacing[2] }, loading && styles.hidden]}>
        {iconPosition === 'leading' && glyph}
        <Text
          variant={size === 'sm' ? 'label' : 'bodyStrong'}
          style={{ color: colors[palette.fg] }}
          numberOfLines={1}
        >
          {label}
        </Text>
        {iconPosition === 'trailing' && glyph}
      </View>
      {loading && (
        <ActivityIndicator
          testID="button-spinner"
          color={colors[palette.fg]}
          style={StyleSheet.absoluteFill}
        />
      )}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
  },
  content: { flexDirection: 'row', alignItems: 'center' },
  fullWidth: { alignSelf: 'stretch' },
  disabled: { opacity: 0.4 },
  hidden: { opacity: 0 },
});
