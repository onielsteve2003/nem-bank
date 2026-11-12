// The free API host sleeps after 15 idle minutes and takes up to a minute to wake
// (architecture §9). These helpers wake it on launch and keep it awake while the app
// is open. `/readyz` is the wake-up probe because it also touches the database, which
// sleeps on its own schedule; `/healthz` is the cheap keep-warm ping.

export type WakeResult = 'ready' | 'unreachable' | 'aborted';

export interface WakeOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Called once when the bank is taking noticeably long, so the app can say so. */
  onSlow?: () => void;
  /** One probe gives up after this long. */
  attemptTimeoutMs?: number;
  /** The first sign of slowness: a probe still pending, or failed, after this long. */
  slowAfterMs?: number;
  /** Stop trying after this long in total. */
  giveUpAfterMs?: number;
  /** Injected so tests need no real time. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

const defaultSchedule = (fn: () => void, ms: number) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

/** True when the path answers 2xx within the timeout. Any failure, 502/503 included, is "not yet". */
export async function probe(
  baseUrl: string,
  path: '/readyz' | '/healthz',
  options: { fetch?: typeof fetch; timeoutMs: number; signal?: AbortSignal },
): Promise<boolean> {
  const doFetch = options.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort);
  try {
    const response = await doFetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** Probes until the bank answers, backing off gently, for at most `giveUpAfterMs`. */
export async function wakeBank(options: WakeOptions): Promise<WakeResult> {
  const {
    baseUrl,
    signal,
    attemptTimeoutMs = 8_000,
    slowAfterMs = 2_500,
    giveUpAfterMs = 90_000,
    sleep = defaultSleep,
    now = Date.now,
    schedule = defaultSchedule,
  } = options;
  const startedAt = now();
  let slow = false;
  const fireSlow = () => {
    if (slow) return;
    slow = true;
    options.onSlow?.();
  };
  const cancelSlow = schedule(fireSlow, slowAfterMs);
  try {
    let delay = 1_500;
    for (;;) {
      if (signal?.aborted) return 'aborted';
      const ok = await probe(baseUrl, '/readyz', {
        fetch: options.fetch,
        timeoutMs: attemptTimeoutMs,
        signal,
      });
      if (signal?.aborted) return 'aborted';
      if (ok) return 'ready';
      fireSlow();
      if (now() - startedAt + delay > giveUpAfterMs) return 'unreachable';
      await sleep(delay, signal);
      delay = Math.min(Math.round(delay * 1.5), 8_000);
    }
  } finally {
    cancelSlow();
  }
}

/** Free hosts sleep after 15 minutes without traffic; ping well inside that. */
export const KEEP_WARM_INTERVAL_MS = 10 * 60_000;
