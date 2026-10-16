import { useEffect } from 'react';
import { StyleSheet, View, type DimensionValue } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useTheme } from '@/theme';

const PULSE_MS = 900;
const MIN_OPACITY = 0.45;

export type Props = {
  width?: DimensionValue;
  height?: number;
  /** Draws a circle of `height` diameter, e.g. for an avatar placeholder. */
  circle?: boolean;
  radius?: number;
};

/**
 * A placeholder block that pulses while content loads. Hidden from screen
 * readers: wrap a group in `SkeletonGroup` so the loading state is announced once.
 * With reduce motion on it stays still.
 */
export function Skeleton({ width = '100%', height = 16, circle = false, radius }: Props) {
  const { colors, radius: radii } = useTheme();
  const reduceMotion = useReducedMotion();
  const opacity = useSharedValue(1);

  useEffect(() => {
    if (reduceMotion) return;
    opacity.set(withRepeat(withTiming(MIN_OPACITY, { duration: PULSE_MS }), -1, true));
    return () => cancelAnimation(opacity);
  }, [opacity, reduceMotion]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          width: circle ? height : width,
          height,
          borderRadius: circle ? radii.pill : (radius ?? radii.sm),
          backgroundColor: colors.raised,
        },
        animatedStyle,
      ]}
    />
  );
}

export type GroupProps = {
  children: React.ReactNode;
  /** What is loading, read once to screen readers, e.g. "Loading transactions". */
  accessibilityLabel?: string;
};

export function SkeletonGroup({ children, accessibilityLabel = 'Loading' }: GroupProps) {
  const { spacing } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ busy: true }}
      style={{ gap: spacing[3] }}
    >
      {children}
    </View>
  );
}

/** A list-row placeholder matching ListItem's layout, so content doesn't jump when it loads. */
export function SkeletonListItem() {
  const { spacing } = useTheme();
  return (
    <View style={[styles.row, { gap: spacing[3], paddingHorizontal: spacing[4] }]}>
      <Skeleton circle height={40} />
      <View style={[styles.flex, { gap: spacing[2] }]}>
        <Skeleton width="60%" height={14} />
        <Skeleton width="35%" height={12} />
      </View>
      <Skeleton width={64} height={14} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 56 },
  flex: { flex: 1 },
});
