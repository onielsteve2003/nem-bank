import { useCallback } from 'react';
import {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

const OFFSET = 10;
const STEP_MS = 50;

/** A horizontal "no" shake for rejected input. Skipped when reduce motion is on. */
export function useShake() {
  const reduceMotion = useReducedMotion();
  const x = useSharedValue(0);

  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));

  const shake = useCallback(() => {
    if (reduceMotion) return;
    x.set(
      withSequence(
        withTiming(-OFFSET, { duration: STEP_MS }),
        withRepeat(withTiming(OFFSET, { duration: STEP_MS * 2 }), 3, true),
        withTiming(0, { duration: STEP_MS }),
      ),
    );
  }, [reduceMotion, x]);

  return { style, shake };
}
