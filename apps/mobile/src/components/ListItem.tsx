import { ChevronRight, type LucideIcon } from 'lucide-react-native';
import { isValidElement, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { haptic } from '@/lib/haptics';
import { useTheme } from '@/theme';

import { Icon } from './Icon';
import { Text } from './Text';

export type Props = {
  title: string;
  subtitle?: string;
  /** A lucide icon (drawn in a tinted circle) or any element, such as an Avatar. */
  leading?: LucideIcon | ReactNode;
  /** Right-hand slot: a MoneyText, Badge, Switch… A plain string renders as muted text. */
  trailing?: ReactNode;
  onPress?: () => void;
  /** Defaults on for pressable rows without their own trailing content. */
  showChevron?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
};

/** One row of a list: a leading visual, up to two lines of text and a trailing slot. */
export function ListItem({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
  showChevron = Boolean(onPress) && trailing === undefined,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
}: Props) {
  const { colors, radius, spacing } = useTheme();

  // Anything that is not already an element is treated as an icon component.
  const leadingNode =
    leading === undefined || leading === null || isValidElement(leading) ? (
      leading
    ) : (
      <View
        style={[styles.iconWrap, { borderRadius: radius.pill, backgroundColor: colors.raised }]}
      >
        <Icon icon={leading as LucideIcon} />
      </View>
    );

  const content = (
    <>
      {leadingNode}
      <View style={styles.text}>
        <Text variant="bodyStrong" numberOfLines={1}>
          {title}
        </Text>
        {subtitle && (
          <Text variant="bodySmall" color="textMuted" numberOfLines={2}>
            {subtitle}
          </Text>
        )}
      </View>
      {typeof trailing === 'string' ? (
        <Text variant="bodySmall" color="textMuted">
          {trailing}
        </Text>
      ) : (
        trailing
      )}
      {showChevron && <Icon icon={ChevronRight} color="textMuted" />}
    </>
  );

  const rowStyle = { gap: spacing[3], paddingHorizontal: spacing[4], paddingVertical: spacing[3] };

  if (!onPress)
    return (
      // A static row with a label reads as one item instead of three fragments.
      <View
        accessible={accessibilityLabel !== undefined}
        accessibilityLabel={accessibilityLabel}
        style={[styles.row, rowStyle]}
      >
        {content}
      </View>
    );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (subtitle ? `${title}, ${subtitle}` : title)}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => {
        haptic('tap');
        onPress();
      }}
      style={({ pressed }) => [
        styles.row,
        rowStyle,
        pressed && { backgroundColor: colors.raised },
        disabled && styles.disabled,
      ]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 56 },
  iconWrap: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, gap: 2 },
  disabled: { opacity: 0.4 },
});
