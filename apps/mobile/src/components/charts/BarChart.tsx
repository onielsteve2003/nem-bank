import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedProps, type SharedValue } from 'react-native-reanimated';
import Svg, { Rect } from 'react-native-svg';

import { useTheme } from '@/theme';

import { Text } from '../Text';
import { ChartFrame, useChartProgress } from './ChartFrame';
import { barLayout, barSummary, type Bar, type Datum, type ValueFormatter } from './chartMath';

const AnimatedRect = Animated.createAnimatedComponent(Rect);

const GAP = 8;
const CORNER = 4;

export type Props = {
  title: string;
  data: readonly Datum[];
  formatValue?: ValueFormatter;
  /** The bar drawn in the brand colour, e.g. the current month. Defaults to the last bar. */
  highlightIndex?: number;
  height?: number;
  width?: number;
};

/** Values must be zero or more (spending, counts); negatives are drawn as zero. */
export function BarChart({
  title,
  data,
  formatValue = String,
  highlightIndex = data.length - 1,
  height = 140,
  width,
}: Props) {
  const { colors, spacing } = useTheme();
  const progress = useChartProgress(data.map((d) => d.value).join());

  return (
    <ChartFrame
      summary={barSummary(title, data, formatValue)}
      height={height}
      width={width}
      footer={
        <View style={[styles.labels, { gap: GAP }]}>
          {data.map((d, i) => (
            <Text
              key={`${d.label}-${i}`}
              variant="caption"
              color={i === highlightIndex ? 'text' : 'textMuted'}
              align="center"
              numberOfLines={1}
              style={[styles.label, { marginTop: spacing[1] }]}
            >
              {d.label}
            </Text>
          ))}
        </View>
      }
    >
      {(w) => (
        <Svg width={w} height={height}>
          {barLayout(data, w, height, GAP).map((bar, i) => (
            <GrowingBar
              key={`${data[i]!.label}-${i}`}
              bar={bar}
              base={height}
              fill={i === highlightIndex ? colors.primaryText : colors.textMuted}
              progress={progress}
            />
          ))}
        </Svg>
      )}
    </ChartFrame>
  );
}

type BarProps = { bar: Bar; base: number; fill: string; progress: SharedValue<number> };

function GrowingBar({ bar, base, fill, progress }: BarProps) {
  const animatedProps = useAnimatedProps(() => {
    const h = bar.height * progress.value;
    return { y: base - h, height: h };
  });
  return (
    <AnimatedRect
      x={bar.x}
      width={bar.width}
      rx={Math.min(CORNER, bar.width / 2)}
      fill={fill}
      animatedProps={animatedProps}
    />
  );
}

const styles = StyleSheet.create({
  labels: { flexDirection: 'row' },
  label: { flex: 1 },
});
