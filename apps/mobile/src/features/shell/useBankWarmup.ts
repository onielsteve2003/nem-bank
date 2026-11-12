import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { env as appEnv, type Env } from '@/lib/env';
import { KEEP_WARM_INTERVAL_MS, probe, wakeBank } from '@/lib/bankWarmup';
import { useBankStore, useSessionStore } from '@/stores';

/** Carry on with the on-device demo bank. The real session means nothing there, so end it. */
export function chooseDemoBank(): void {
  useBankStore.getState().fallBackToDemo();
  if (useSessionStore.getState().status === 'signedIn') useSessionStore.getState().signOut();
}

/**
 * Cold-start handling (T31.4). Against the real API: wake the bank on launch and say so
 * when it is slow, keep it warm while the app is open and signed in, and check again
 * when the app returns after a long time away. Does nothing on the mock bank.
 */
export function useBankWarmup(env: Env = appEnv): void {
  const client = useQueryClient();
  const demoFallback = useBankStore((s) => s.demoFallback);
  const round = useBankStore((s) => s.round);
  const signedIn = useSessionStore((s) => s.status === 'signedIn');
  const baseUrl = env.apiMode === 'http' && !demoFallback ? env.apiUrl : null;

  // Wake it. A new round starts on launch, on "try again" and after a failed keep-warm.
  useEffect(() => {
    if (!baseUrl) return;
    const controller = new AbortController();
    const bank = useBankStore.getState();
    const wasBlocked = bank.status === 'waking' || bank.status === 'unreachable';
    bank.begin();
    void wakeBank({
      baseUrl,
      signal: controller.signal,
      onSlow: () => useBankStore.getState().markWaking(),
    }).then((result) => {
      if (result === 'aborted') return;
      if (result === 'unreachable') {
        useBankStore.getState().markUnreachable();
        return;
      }
      const showedOverlay = useBankStore.getState().status === 'waking' || wasBlocked;
      useBankStore.getState().markReady();
      // Whatever failed while it slept is fetched again now that it answers.
      if (showedOverlay) void client.invalidateQueries();
    });
    return () => controller.abort();
  }, [baseUrl, round, client]);

  // Keep it warm while the app is open and someone is signed in.
  useEffect(() => {
    if (!baseUrl || !signedIn) return;
    const check = async () => {
      if (AppState.currentState !== 'active') return;
      const ok = await probe(baseUrl, '/healthz', { timeoutMs: 8_000 });
      if (ok) useBankStore.getState().markReady();
      else useBankStore.getState().retry();
    };
    const timer = setInterval(() => void check(), KEEP_WARM_INTERVAL_MS);
    // Back from a long time away: the host has likely gone to sleep.
    const sub = AppState.addEventListener('change', (state) => {
      const last = useBankStore.getState().lastOkAt;
      if (state === 'active' && (last === null || Date.now() - last > KEEP_WARM_INTERVAL_MS)) {
        useBankStore.getState().retry();
      }
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [baseUrl, signedIn]);
}
