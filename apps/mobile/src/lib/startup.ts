// Startup timing (PRD: interactive in under 2.5 s). The root layout imports this module
// first, so the clock starts as soon as the app's own code runs. Native launch and bundle
// loading happen before that and are not counted.

export const STARTUP_TARGET_MS = 2500;

export function createStartupTimer(startedAt: number) {
  let interactiveAfterMs: number | null = null;
  return {
    /**
     * Home calls this when it first shows real balances. Home renders under the lock screen,
     * so the time does not include typing the PIN. Only the first call counts.
     */
    markInteractive(now: number = Date.now()): void {
      if (interactiveAfterMs === null) interactiveAfterMs = now - startedAt;
    },
    /** Milliseconds from app start to Home showing balances, or null before Home has loaded. */
    timeToInteractive: (): number | null => interactiveAfterMs,
  };
}

export const { markInteractive, timeToInteractive } = createStartupTimer(Date.now());
