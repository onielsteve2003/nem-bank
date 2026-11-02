import { useReducedMotion } from 'react-native-reanimated';

import { usePreferencesStore } from '@/stores/preferences';

/**
 * Whether to cut motion (SET-4): the phone's own setting, or Settings →
 * Reduce motion → Always reduce. Use this, not Reanimated's
 * `useReducedMotion`, which only knows the phone's setting.
 */
export function useReduceMotion(): boolean {
  const system = useReducedMotion();
  const always = usePreferencesStore((s) => s.reduceMotion === 'always');
  return always || system;
}
