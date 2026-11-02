import { EASING, type ColorTokens } from '@nem/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { ChartLine } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { Easing, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';

import { useLowData } from '@/lib/lowData';
import { useReduceMotion } from '@/lib/motion';
import { useTheme } from '@/theme';

import { Button } from '../Button';
import { Icon } from '../Icon';
import { Text } from '../Text';

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
  const reduceMotion = useReduceMotion();
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

/**
 * Measures the width, and makes the whole chart one screen-reader stop that
 * reads `summary`. In low-data mode (SET-3) the chart waits for a tap and
 * shows the summary in words meanwhile.
 */
export function ChartFrame({ summary, height, width: fixedWidth, children, footer }: FrameProps) {
  const { colors, radius, spacing } = useTheme();
  const { t } = useTranslation();
  const lowData = useLowData();
  const [shown, setShown] = useState(false);
  const [measured, setMeasured] = useState(0);
  const width = fixedWidth ?? measured;

  if (lowData && !shown) {
    return (
      <View
        style={[
          styles.held,
          {
            minHeight: height,
            gap: spacing[2],
            padding: spacing[4],
            borderRadius: radius.md,
            borderColor: colors.border,
          },
        ]}
      >
        <Icon icon={ChartLine} color="textMuted" />
        <Text variant="caption" color="textMuted" style={styles.centered}>
          {summary}
        </Text>
        <Button
          label={t('components.chart.show')}
          accessibilityHint={t('components.chart.hidden')}
          size="sm"
          variant="secondary"
          onPress={() => setShown(true)}
        />
      </View>
    );
  }

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

const styles = StyleSheet.create({
  held: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
  },
  centered: { textAlign: 'center' },
});
