import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { useToast } from '@/components';
import { canRefresh, useSessionStore } from '@/stores';

const announceExpiry = (toast: ReturnType<typeof useToast>) =>
  toast.show({ message: 'Your session ended. Sign in again to continue.', tone: 'info' });

/** setTimeout stores its delay in 32 bits; longer waits are re-armed when they fire. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Ends the session the moment it can no longer be refreshed (a timer, plus a
 * check whenever the app returns to the foreground, since timers sleep in the
 * background), wipes cached bank data on every sign-out, and tells the user
 * why they are back on the sign-in screen when the bank ended the session.
 */
export function useSessionWatcher() {
  const client = useQueryClient();
  const toast = useToast();
  const refreshExpiry = useSessionStore((s) => s.session?.refreshTokenExpiresAt);

  useEffect(() => {
    if (!refreshExpiry) return;
    const check = () => {
      const { session, expire } = useSessionStore.getState();
      if (session && !canRefresh(session)) expire();
    };
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      const wait = Date.parse(refreshExpiry) - Date.now();
      timer = setTimeout(
        () => {
          check();
          if (useSessionStore.getState().status === 'signedIn') arm();
        },
        Math.max(0, Math.min(wait, MAX_TIMER_MS)),
      );
    };
    arm();
    const sub = AppState.addEventListener('change', (state) => state === 'active' && check());
    return () => {
      clearTimeout(timer);
      sub.remove();
    };
  }, [refreshExpiry]);

  useEffect(() => {
    // A stored session that lapsed while the app was closed.
    if (useSessionStore.getState().endedBy === 'expired') announceExpiry(toast);
  }, [toast]);

  useEffect(
    () =>
      useSessionStore.subscribe((state, prev) => {
        if (prev.status !== 'signedIn' || state.status !== 'signedOut') return;
        // The next person on this phone must not see the last one's balances, even offline.
        client.clear();
        if (state.endedBy === 'expired') announceExpiry(toast);
      }),
    [client, toast],
  );
}
