import { X, type LucideIcon } from 'lucide-react-native';
import { Pressable, StyleSheet } from 'react-native';

import { haptic } from '@/lib/haptics';
import { useTheme } from '@/theme';

import { touchSlop } from './Button';
import { Icon } from './Icon';
import { PressableScale } from './PressableScale';
import { Text } from './Text';

const HEIGHT = 36;
const REMOVE_SIZE = 28;

export type Props = {
  label: string;
  icon?: LucideIcon;
  /** Filter chips toggle; the selected state is announced, not only coloured. */
  selected?: boolean;
  onPress?: () => void;
  /** Adds a remove button, e.g. on an applied filter. */
  onRemove?: () => void;
  disabled?: boolean;
};

export function Chip({
  label,
  icon,
  selected = false,
  onPress,
  onRemove,
  disabled = false,
}: Props) {
  const { colors, radius, spacing } = useTheme();
  const fg = selected ? 'onPrimary' : 'text';

  return (
    <PressableScale
      accessibilityRole={onPress ? 'togglebutton' : 'text'}
      accessibilityLabel={label}
      accessibilityState={{ selected, checked: onPress ? selected : undefined, disabled }}
      hitSlop={touchSlop(HEIGHT)}
      disabled={disabled || !onPress}
      onPress={() => {
        haptic('selection');
        onPress?.();
      }}
      style={[
        styles.base,
        {
          minHeight: HEIGHT,
          gap: spacing[1],
          paddingLeft: spacing[3],
          paddingRight: onRemove ? spacing[1] : spacing[3],
          borderRadius: radius.pill,
          backgroundColor: selected ? colors.primary : colors.raised,
          borderColor: selected ? colors.primary : colors.border,
        },
        disabled && styles.disabled,
      ]}
    >
      {icon && <Icon icon={icon} size="sm" color={fg} />}
      <Text variant="label" style={{ color: colors[fg] }} numberOfLines={1}>
        {label}
      </Text>
      {onRemove && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove ${label}`}
          hitSlop={touchSlop(REMOVE_SIZE)}
          disabled={disabled}
          onPress={() => {
            haptic('tap');
            onRemove();
          }}
          style={[styles.remove, { borderRadius: radius.pill }]}
        >
          <Icon icon={X} size="sm" color={fg} />
        </Pressable>
      )}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
  },
  remove: {
    width: REMOVE_SIZE,
    height: REMOVE_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: { opacity: 0.4 },
});
