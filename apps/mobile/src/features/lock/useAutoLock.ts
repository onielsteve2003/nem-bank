import { useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { useLockStore, usePreferencesStore } from '@/stores';

/** True once the app has been away for at least the user's auto-lock time (AUTH-12). */
export function shouldLock(leftAt: number | null, now: number, autoLockSeconds: number): boolean {
  return leftAt !== null && now - leftAt >= autoLockSeconds * 1_000;
}

/**
 * Locks the app when it comes back after `autoLockSeconds` (60 s by default) in
 * the background. Returns whether the app is out of the foreground, so the
 * privacy cover can hide balances from the app-switcher snapshot.
 */
export function useAutoLock(now: () => number = Date.now): { obscured: boolean } {
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const leftAt = useRef<number | null>(null);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      setAppState(next);
      // The clock starts at the real background only: `inactive` is also the
      // Face ID sheet, Control Center or an incoming call.
      if (next === 'background') {
        leftAt.current ??= now();
      } else if (next === 'active') {
        const { autoLockSeconds } = usePreferencesStore.getState();
        if (shouldLock(leftAt.current, now(), autoLockSeconds)) useLockStore.getState().lock();
        leftAt.current = null;
      }
    });
    return () => subscription.remove();
  }, [now]);

  return { obscured: appState !== 'active' && appState !== 'unknown' };
}
