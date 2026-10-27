import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import { useTheme } from '@/theme';

export type Props = {
  count: number;
  index: number;
  /** 0→1 through the current slide. */
  progress: SharedValue<number>;
};

function Segment({
  state,
  progress,
}: {
  state: 'done' | 'now' | 'next';
  progress: SharedValue<number>;
}) {
  const { colors, radius } = useTheme();
  const fill = useAnimatedStyle(() => ({
    width: `${(state === 'done' ? 1 : state === 'now' ? progress.value : 0) * 100}%`,
  }));
  return (
    <View style={[styles.segment, { backgroundColor: colors.border, borderRadius: radius.pill }]}>
      <Animated.View
        style={[
          styles.segmentFill,
          { backgroundColor: colors.text, borderRadius: radius.pill },
          fill,
        ]}
      />
    </View>
  );
}

/** The bars across the top of a story: done, filling, still to come. */
export function StoryProgress({ count, index, progress }: Props) {
  const { spacing } = useTheme();
  return (
    <View
      style={[styles.row, { gap: spacing[1] }]}
      accessible
      accessibilityLabel={`Slide ${index + 1} of ${count}`}
    >
      {Array.from({ length: count }, (_, i) => (
        <Segment
          key={i}
          state={i < index ? 'done' : i === index ? 'now' : 'next'}
          progress={progress}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  segment: { flex: 1, height: 3, overflow: 'hidden' },
  segmentFill: { height: '100%' },
});
