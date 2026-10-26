import { Accelerometer } from 'expo-sensors';
import { useEffect } from 'react';
import { useSharedValue, withSpring, type SharedValue } from 'react-native-reanimated';

export const MAX_TILT_DEG = 12;
const UPDATE_MS = 50;
/** How quickly the resting pose follows the phone, so the card settles flat wherever it is held. */
const BASELINE_FOLLOW = 0.04;
const TILT_SPRING = { damping: 18, stiffness: 120, mass: 1 };

export type Gravity = { x: number; y: number };

/**
 * Card tilt in degrees from how far the phone has moved from its resting pose.
 * Gravity is in g (−1…1 per axis); a 0.5 g swing reaches the full tilt.
 */
export function tiltFromGravity(sample: Gravity, baseline: Gravity) {
  const clamp = (v: number) => Math.max(-MAX_TILT_DEG, Math.min(MAX_TILT_DEG, v));
  return {
    rotateY: clamp((sample.x - baseline.x) * MAX_TILT_DEG * 2),
    rotateX: clamp((sample.y - baseline.y) * MAX_TILT_DEG * 2),
  };
}

export const followBaseline = (baseline: Gravity, sample: Gravity): Gravity => ({
  x: baseline.x + (sample.x - baseline.x) * BASELINE_FOLLOW,
  y: baseline.y + (sample.y - baseline.y) * BASELINE_FOLLOW,
});

/**
 * Tilts with the phone using the motion sensor's gravity reading, which needs no
 * permission prompt and does not drift like integrated gyroscope rates. Off when
 * `enabled` is false (reduce motion) or the device has no sensor (most desktops).
 */
export function useDeviceTilt(enabled: boolean): {
  rotateX: SharedValue<number>;
  rotateY: SharedValue<number>;
} {
  const rotateX = useSharedValue(0);
  const rotateY = useSharedValue(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let subscription: { remove: () => void } | undefined;
    let baseline: Gravity | undefined;

    void Accelerometer.isAvailableAsync().then((available) => {
      if (!available || cancelled) return;
      // Some browsers report a sensor the web module can't subscribe to: stay flat.
      try {
        Accelerometer.setUpdateInterval(UPDATE_MS);
        subscription = Accelerometer.addListener((sample) => {
          baseline = baseline ? followBaseline(baseline, sample) : sample;
          const tilt = tiltFromGravity(sample, baseline);
          rotateX.set(withSpring(tilt.rotateX, TILT_SPRING));
          rotateY.set(withSpring(tilt.rotateY, TILT_SPRING));
        });
      } catch {
        subscription = undefined;
      }
    });

    return () => {
      cancelled = true;
      subscription?.remove();
      rotateX.set(withSpring(0, TILT_SPRING));
      rotateY.set(withSpring(0, TILT_SPRING));
    };
  }, [enabled, rotateX, rotateY]);

  return { rotateX, rotateY };
}
