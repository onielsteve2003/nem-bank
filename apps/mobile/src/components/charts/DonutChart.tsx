import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedProps, type SharedValue } from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';

import { useTheme } from '@/theme';

import { Text } from '../Text';
import { CHART_PALETTE, ChartFrame, useChartProgress } from './ChartFrame';
import {
  arcPath,
  donutSlices,
  donutSummary,
  wholePercents,
  type Datum,
  type ValueFormatter,
} from './chartMath';

const AnimatedPath = Animated.createAnimatedComponent(Path);

/** Space between slices, as a fraction of a turn. */
const SLICE_GAP = 0.008;
const SWATCH = 10;

export type Props = {
  title: string;
  data: readonly Datum[];
  formatValue?: ValueFormatter;
  size?: number;
  thickness?: number;
  /** Shown in the hole, e.g. the total spent. */
  center?: ReactNode;
};

export function DonutChart({
  title,
  data,
  formatValue = String,
  size = 180,
  thickness = 22,
  center,
}: Props) {
  const { colors, spacing } = useTheme();
  const progress = useChartProgress(data.map((d) => d.value).join());
  const slices = donutSlices(data);
  const percents = wholePercents(slices.map((s) => s.fraction));
  const gap = slices.filter((s) => s.fraction > 0).length > 1 ? SLICE_GAP : 0;
  const c = size / 2;
  const r = c - thickness / 2;
  const colorAt = (i: number) => colors[CHART_PALETTE[i % CHART_PALETTE.length]!];

  return (
    <ChartFrame
      summary={donutSummary(title, data, formatValue)}
      height={size}
      width={size}
      footer={
        <View style={{ gap: spacing[2], marginTop: spacing[2] }}>
          {data.map((d, i) => (
            <View key={`${d.label}-${i}`} style={[styles.legendRow, { gap: spacing[2] }]}>
              <View style={[styles.swatch, { backgroundColor: colorAt(i) }]} />
              <Text variant="bodySmall" style={styles.flex} numberOfLines={1}>
                {d.label}
              </Text>
              <Text variant="bodySmall" tabular>
                {formatValue(d.value, i)}
              </Text>
              <Text
                variant="caption"
                color="textMuted"
                tabular
                style={styles.percent}
                align="right"
              >
                {percents[i]}%
              </Text>
            </View>
          ))}
        </View>
      }
    >
      {() => (
        <View>
          <Svg width={size} height={size}>
            <Circle
              cx={c}
              cy={c}
              r={r}
              stroke={colors.raised}
              strokeWidth={thickness}
              fill="none"
            />
            {slices.map((s, i) =>
              s.fraction > 0 ? (
                <Slice
                  key={`${data[i]!.label}-${i}`}
                  center={c}
                  radius={r}
                  start={s.start}
                  fraction={Math.max(0, s.fraction - gap)}
                  stroke={colorAt(i)}
                  thickness={thickness}
                  progress={progress}
                />
              ) : null,
            )}
          </Svg>
          {center && <View style={[StyleSheet.absoluteFill, styles.center]}>{center}</View>}
        </View>
      )}
    </ChartFrame>
  );
}

type SliceProps = {
  center: number;
  radius: number;
  start: number;
  fraction: number;
  stroke: string;
  thickness: number;
  progress: SharedValue<number>;
};

/** One slice, swept round clockwise as `progress` goes 0 → 1. */
function Slice({ center, radius, start, fraction, stroke, thickness, progress }: SliceProps) {
  const animatedProps = useAnimatedProps(() => {
    const shown = Math.min(Math.max(progress.value - start, 0), fraction);
    return { d: shown <= 0 ? '' : arcPath(center, center, radius, start, start + shown) };
  });
  return (
    <AnimatedPath
      fill="none"
      stroke={stroke}
      strokeWidth={thickness}
      strokeLinecap="butt"
      animatedProps={animatedProps}
    />
  );
}

const styles = StyleSheet.create({
  legendRow: { flexDirection: 'row', alignItems: 'center' },
  swatch: { width: SWATCH, height: SWATCH, borderRadius: SWATCH / 2 },
  flex: { flex: 1 },
  percent: { minWidth: 36 },
  center: { alignItems: 'center', justifyContent: 'center' },
});
