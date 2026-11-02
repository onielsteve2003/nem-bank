import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { useReduceMotion } from '@/lib/motion';
import i18n from '@/lib/i18n';
import { useTheme } from '@/theme';

import { Text } from './Text';

function Dot({ index }: { index: number }) {
  const { colors } = useTheme();
  const reduceMotion = useReduceMotion();
  const lift = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) return;
    lift.value = withDelay(
      index * 150,
      withRepeat(
        withSequence(withTiming(-3, { duration: 250 }), withTiming(0, { duration: 250 })),
        -1,
      ),
    );
  }, [index, lift, reduceMotion]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: lift.value }] }));
  return <Animated.View style={[styles.dot, { backgroundColor: colors.textMuted }, style]} />;
}

/** Three bouncing dots while the agent writes (SUP-1); still dots with reduce motion. */
export function TypingIndicator({ name }: { name: string | null }) {
  const { colors, radius, spacing } = useTheme();
  const who = name ?? i18n.t('components.typing.support');
  return (
    <View
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={i18n.t('components.typing.label', { name: who })}
      style={[styles.row, { gap: spacing[2] }]}
    >
      <View
        style={[
          styles.bubble,
          {
            backgroundColor: colors.raised,
            borderRadius: radius.lg,
            paddingHorizontal: spacing[3],
            paddingVertical: spacing[3],
          },
        ]}
      >
        {[0, 1, 2].map((i) => (
          <Dot key={i} index={i} />
        ))}
      </View>
      <Text variant="caption" color="textMuted">
        {`${who} is typing`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  bubble: { flexDirection: 'row', gap: 4 },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
