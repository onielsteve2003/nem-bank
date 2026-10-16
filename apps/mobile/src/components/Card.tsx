import type { ReactNode } from 'react';
import {
  StyleSheet,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { haptic } from '@/lib/haptics';
import { useTheme } from '@/theme';

import { PressableScale } from './PressableScale';

export type CardVariant = 'surface' | 'raised' | 'outline';

export type Props = Omit<PressableProps, 'children' | 'style'> & {
  children: ReactNode;
  variant?: CardVariant;
  /** `false` for edge-to-edge content such as a group of list rows. */
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** A container for grouped content. With `onPress` the whole card is one pressable target. */
export function Card({
  children,
  variant = 'surface',
  padded = true,
  onPress,
  style,
  ...rest
}: Props) {
  const { colors, radius, spacing, elevation, scheme } = useTheme();

  const cardStyle = [
    styles.base,
    {
      borderRadius: radius.lg,
      backgroundColor: variant === 'raised' ? colors.raised : colors.surface,
      borderColor: variant === 'outline' ? colors.border : 'transparent',
      padding: padded ? spacing[4] : 0,
    },
    // Shadows vanish on near-black, so dark mode separates layers by colour alone.
    variant !== 'outline' && scheme === 'light' && elevation.low,
    style,
  ];

  if (!onPress) return <View style={cardStyle}>{children}</View>;

  return (
    <PressableScale
      accessibilityRole="button"
      {...rest}
      onPress={(e) => {
        haptic('tap');
        onPress(e);
      }}
      style={cardStyle}
    >
      {children}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  base: { borderWidth: StyleSheet.hairlineWidth },
});
