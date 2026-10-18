import { problem } from '../errors';
import { createEmitter } from '../realtime';

// Network conditions for the mock bank (T3.8), so every screen's loading, error
// and offline states can be seen without a server. Demo Controls change these.

export type LatencyProfile = 'off' | 'fast' | 'realistic' | 'slow';

export interface SimulationSettings {
  latency: LatencyProfile;
  /** Share of calls (0 to 1) that fail with a 503 before they run. */
  errorRate: number;
  /**
   * Also fail some money calls *after* they ran, like a timeout on the way back.
   * A retry with the same idempotency key must then replay, not pay twice.
   */
  failAfterCommit: boolean;
  offline: boolean;
  /** Friends send small amounts now and then while the app is open. */
  ambientActivity: boolean;
}

export const DEFAULT_SIMULATION: SimulationSettings = {
  latency: 'realistic',
  errorRate: 0,
  failAfterCommit: false,
  offline: false,
  ambientActivity: false,
};

/** Milliseconds [min, max] per profile; writes take longer, as on a real API. */
const PROFILES: Record<LatencyProfile, { read: [number, number]; write: [number, number] }> = {
  off: { read: [0, 0], write: [0, 0] },
  fast: { read: [40, 120], write: [80, 200] },
  realistic: { read: [180, 600], write: [450, 1_300] },
  slow: { read: [1_800, 3_500], write: [3_000, 6_000] },
};

export function latencyFor(profile: LatencyProfile, write: boolean, random: () => number): number {
  const [min, max] = PROFILES[profile][write ? 'write' : 'read'];
  return Math.round(min + random() * (max - min));
}

/** Waits `ms`, or rejects as soon as the caller aborts (TanStack Query cancels). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    signal?.throwIfAborted();
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export const offlineError = () =>
  problem(503, 'offline', 'You are offline', {
    detail: 'Check your connection and try again. Nothing was sent.',
  });

export const injectedError = () =>
  problem(503, 'service_unavailable', 'Something went wrong on our side', {
    detail: 'Simulated outage (Demo Controls). Try again.',
  });

export const timeoutError = () =>
  problem(504, 'gateway_timeout', 'We did not hear back in time', {
    detail: 'It may have gone through. Check your history before trying again.',
  });

export interface Simulation {
  get(): SimulationSettings;
  set(patch: Partial<SimulationSettings>): void;
  subscribe(listener: (settings: SimulationSettings) => void): () => void;
}

export function createSimulation(initial: Partial<SimulationSettings> = {}): Simulation {
  let settings: SimulationSettings = { ...DEFAULT_SIMULATION, ...initial };
  const changes = createEmitter<SimulationSettings>();
  return {
    get: () => settings,
    set(patch) {
      const errorRate = patch.errorRate ?? settings.errorRate;
      if (!(errorRate >= 0 && errorRate <= 1))
        throw new RangeError('errorRate must be between 0 and 1');
      settings = { ...settings, ...patch };
      changes.emit(settings);
    },
    subscribe: changes.subscribe,
  };
}
