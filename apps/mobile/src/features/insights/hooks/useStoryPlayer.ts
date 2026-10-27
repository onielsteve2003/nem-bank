import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelAnimation,
  Easing,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

/** How long each slide stays up before the story moves on. */
export const SLIDE_MS = 5_000;

export type StoryPlayer = {
  index: number;
  paused: boolean;
  /** 0→1 through the current slide, for the progress bar. */
  progress: SharedValue<number>;
  next: () => void;
  previous: () => void;
  setPaused: (paused: boolean) => void;
};

/**
 * Plays `count` slides like a story: each runs for SLIDE_MS then moves on,
 * stopping on the last. Pausing keeps the time already spent on the slide.
 * The timer runs in JS; the shared value only draws the bar.
 */
export function useStoryPlayer(count: number, enabled = true): StoryPlayer {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const progress = useSharedValue(0);
  // Time spent on a slide before the latest pause; another slide starts at 0.
  const spent = useRef({ index: 0, ms: 0 });

  const go = useCallback(
    (to: number) => {
      const next = Math.max(0, Math.min(count - 1, to));
      // An empty bar straight away, even while paused.
      if (next !== index) progress.set(0);
      setIndex(next);
    },
    [count, index, progress],
  );

  const last = index >= count - 1;
  const running = enabled && !paused && count > 0;
  useEffect(() => {
    if (!running) return;
    const before = spent.current.index === index ? spent.current.ms : 0;
    const left = SLIDE_MS - before;
    const startedAt = Date.now();
    progress.set(withTiming(1, { duration: left, easing: Easing.linear }));
    const timer = last ? undefined : setTimeout(() => go(index + 1), left);
    return () => {
      if (timer) clearTimeout(timer);
      cancelAnimation(progress);
      spent.current = { index, ms: Math.min(SLIDE_MS, before + Date.now() - startedAt) };
    };
  }, [running, index, last, go, progress]);

  return {
    index,
    paused,
    progress,
    next: () => go(index + 1),
    previous: () => go(index - 1),
    setPaused,
  };
}
