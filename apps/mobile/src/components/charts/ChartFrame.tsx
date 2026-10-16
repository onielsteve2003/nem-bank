import { EASING, type ColorTokens } from '@nem/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import {
  Easing,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { useTheme } from '@/theme';

/** Draw-in length. Longer than the 300 ms UI cap on purpose: a chart draws once, on entry, and must read as drawing. */
export const CHART_DRAW_MS = 600;

/** Series colours that hold 3:1 against the surface in both themes. Every chart also labels values in text. */
export const CHART_PALETTE: readonly (keyof ColorTokens)[] = [
  'primaryText',
  'info',
  'success',
  'warning',
  'danger',
  'textMuted',
];

/** 0 → 1 over the draw-in; restarts when `key` changes. Starts at 1 with reduce motion. */
export function useChartProgress(key: string): SharedValue<number> {
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(reduceMotion ? 1 : 0);

  useEffect(() => {
    if (reduceMotion) {
      progress.set(1);
      return;
    }
    progress.set(0);
    progress.set(
      withTiming(1, { duration: CHART_DRAW_MS, easing: Easing.bezier(...EASING.enter) }),
    );
  }, [key, progress, reduceMotion]);

  return progress;
}

export type FrameProps = {
  /** Read to screen readers in place of the drawing. */
  summary: string;
  height: number;
  /** Fixed width; otherwise the chart fills its container. */
  width?: number;
  children: (width: number) => ReactNode;
  footer?: ReactNode;
};

/** Measures the width, and makes the whole chart one screen-reader stop that reads `summary`. */
export function ChartFrame({ summary, height, width: fixedWidth, children, footer }: FrameProps) {
  const { spacing } = useTheme();
  const [measured, setMeasured] = useState(0);
  const width = fixedWidth ?? measured;

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={summary}
      style={{ gap: spacing[2] }}
    >
      <View
        style={{ height, width: fixedWidth, alignSelf: fixedWidth ? 'center' : 'stretch' }}
        onLayout={(e) => setMeasured(Math.round(e.nativeEvent.layout.width))}
      >
        {width > 0 && children(width)}
      </View>
      {footer}
    </View>
  );
}
