import type { ColorTokens } from '@nem/shared';
import { useId } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedProps, type SharedValue } from 'react-native-reanimated';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';

import { useTheme } from '@/theme';

import { Text } from '../Text';
import { ChartFrame, useChartProgress } from './ChartFrame';
import {
  areaPath,
  linePath,
  linePoints,
  lineSummary,
  pathLength,
  type Datum,
  type Point,
  type ValueFormatter,
} from './chartMath';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

const PAD = 8;
const STROKE = 2.5;

export type Props = {
  /** Names the chart for screen readers, e.g. "USD to NGN, last 7 days". */
  title: string;
  data: readonly Datum[];
  formatValue?: ValueFormatter;
  height?: number;
  width?: number;
  color?: keyof ColorTokens;
};

export function LineChart({
  title,
  data,
  formatValue = String,
  height = 160,
  width,
  color = 'primaryText',
}: Props) {
  const { colors } = useTheme();
  const progress = useChartProgress(data.map((d) => d.value).join());
  const first = data[0];
  const last = data.at(-1);

  return (
    <ChartFrame
      summary={lineSummary(title, data, formatValue)}
      height={height}
      width={width}
      footer={
        first &&
        last && (
          <View style={styles.axis}>
            <Text variant="caption" color="textMuted">
              {first.label}
            </Text>
            <Text variant="caption" color="textMuted">
              {last.label}
            </Text>
          </View>
        )
      }
    >
      {(w) =>
        data.length === 0 ? null : (
          <Line
            points={linePoints(data, w, height, PAD)}
            width={w}
            height={height}
            stroke={colors[color]}
            progress={progress}
          />
        )
      }
    </ChartFrame>
  );
}

type LineProps = {
  points: Point[];
  width: number;
  height: number;
  stroke: string;
  progress: SharedValue<number>;
};

function Line({ points, width, height, stroke, progress }: LineProps) {
  // Unique per chart so two charts on one screen don't share a gradient; React ids hold characters url() rejects.
  const fillId = `line-fill-${useId().replace(/[^\w-]/g, '')}`;
  const length = pathLength(points);
  const end = points.at(-1)!;

  const lineProps = useAnimatedProps(() => ({
    strokeDashoffset: length * (1 - progress.value),
  }));
  const fillProps = useAnimatedProps(() => ({ opacity: progress.value }));
  const dotProps = useAnimatedProps(() => ({ r: progress.value > 0.95 ? 4 : 0 }));

  return (
    <Svg width={width} height={height}>
      <Defs>
        <LinearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={stroke} stopOpacity={0.25} />
          <Stop offset="1" stopColor={stroke} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <AnimatedPath
        d={areaPath(points, height)}
        fill={`url(#${fillId})`}
        animatedProps={fillProps}
      />
      <AnimatedPath
        d={linePath(points)}
        fill="none"
        stroke={stroke}
        strokeWidth={STROKE}
        strokeLinejoin="round"
        strokeLinecap="round"
        strokeDasharray={[length, length]}
        animatedProps={lineProps}
      />
      <AnimatedCircle cx={end.x} cy={end.y} fill={stroke} animatedProps={dotProps} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  axis: { flexDirection: 'row', justifyContent: 'space-between' },
});
