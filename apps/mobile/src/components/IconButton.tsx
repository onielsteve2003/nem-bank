import type { LucideIcon } from 'lucide-react-native';
import {
  StyleSheet,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { haptic, type HapticKind } from '@/lib/haptics';
import { useTheme } from '@/theme';

import { BUTTON_PALETTE, touchSlop, type ButtonVariant } from './Button';
import { Icon } from './Icon';
import { PressableScale } from './PressableScale';

export type IconButtonSize = 'sm' | 'md' | 'lg';

const DIAMETER: Record<IconButtonSize, number> = { sm: 32, md: 44, lg: 56 };

export type Props = Omit<PressableProps, 'children' | 'style' | 'accessibilityLabel'> & {
  icon: LucideIcon;
  /** Required: an icon alone tells a screen reader nothing. */
  accessibilityLabel: string;
  variant?: ButtonVariant;
  size?: IconButtonSize;
  haptic?: HapticKind | false;
  style?: StyleProp<ViewStyle>;
};

export function IconButton({
  icon,
  accessibilityLabel,
  variant = 'secondary',
  size = 'md',
  disabled = false,
  haptic: hapticKind = 'tap',
  onPress,
  style,
  ...rest
}: Props) {
  const { colors, radius } = useTheme();
  const palette = BUTTON_PALETTE[variant];
  const diameter = DIAMETER[size];

  const handlePress = (e: GestureResponderEvent) => {
    if (hapticKind) haptic(hapticKind);
    onPress?.(e);
  };

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: Boolean(disabled) }}
      hitSlop={touchSlop(diameter)}
      {...rest}
      disabled={disabled}
      onPress={handlePress}
      style={[
        styles.base,
        {
          width: diameter,
          height: diameter,
          borderRadius: radius.pill,
          backgroundColor: palette.fill ? colors[palette.fill] : 'transparent',
          borderColor: palette.border ? colors[palette.border] : 'transparent',
        },
        disabled && styles.disabled,
        style,
      ]}
    >
      <Icon icon={icon} size={size} color={palette.fg} />
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  disabled: { opacity: 0.4 },
});
