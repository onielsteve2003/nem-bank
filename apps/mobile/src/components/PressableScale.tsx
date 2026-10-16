import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { useTheme } from '@/theme';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const PRESSED_SCALE = 0.96;
const PRESSED_OPACITY = 0.7;

export type Props = Omit<PressableProps, 'style'> & {
  style?: StyleProp<ViewStyle>;
};

/**
 * Pressable with the kit's press feedback: a quick spring shrink on the UI thread.
 * With reduce motion on, it dims instead of moving.
 */
export function PressableScale({ style, onPressIn, onPressOut, ...rest }: Props) {
  const { motion } = useTheme();
  const reduceMotion = useReducedMotion();
  const pressed = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() =>
    reduceMotion
      ? { opacity: 1 - pressed.value * (1 - PRESSED_OPACITY) }
      : { transform: [{ scale: 1 - pressed.value * (1 - PRESSED_SCALE) }] },
  );

  return (
    <AnimatedPressable
      {...rest}
      onPressIn={(e) => {
        pressed.value = reduceMotion ? 1 : withSpring(1, motion.spring.snappy);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        pressed.value = reduceMotion ? 0 : withSpring(0, motion.spring.snappy);
        onPressOut?.(e);
      }}
      style={[style, animatedStyle]}
    />
  );
}
