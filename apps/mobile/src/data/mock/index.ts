import type { RealtimeEvent } from '@nem/contracts';

import type { CallOptions } from '../contract';
import type { Dispatcher } from '../dispatch';
import { repositoriesFromDispatcher } from '../dispatch';
import { createEmitter, type RealtimeSource, type RealtimeStatus } from '../realtime';
import type { Repositories } from '../repositories';
import { DEFAULT_SEED, loadOrSeedBank, resetBank } from './bank';
import { buildMockDomains } from './domains';
import { ambientIncoming } from './domains/misc';
import { diffEvents, fingerprint } from './events';
import { createDeviceStore } from './persistence/store';
import type { SnapshotStore } from './persistence/types';
import { MockBank } from './runtime';
import {
  createSimulation,
  injectedError,
  latencyFor,
  offlineError,
  sleep,
  timeoutError,
  type Simulation,
  type SimulationSettings,
} from './simulation';

export { DEMO_OTP, DEMO_PASSWORD } from './domains/auth';
export {
  DEFAULT_SIMULATION,
  type LatencyProfile,
  type Simulation,
  type SimulationSettings,
} from './simulation';

export interface MockOptions {
  /** Where the bank is saved; SQLite on devices, localStorage on web by default. */
  store?: SnapshotStore;
  /** The device clock; Demo Controls time travel is added on top. */
  clock?: () => Date;
  seed?: number;
  /** Starting network conditions; realistic latency by default. */
  simulation?: Partial<SimulationSettings>;
  /** Randomness for latency and injected errors (seed it in tests). */
  random?: () => number;
  /** How often background work runs while realtime has listeners. */
  pulseMs?: number;
}

export interface MockBankHandle {
  repositories: Repositories;
  realtime: RealtimeSource;
  simulation: Simulation;
  /** Runs one round of background work now and emits what changed. */
  pulse(): Promise<RealtimeEvent[]>;
}

/** Calls that only read: no save unless background work changed something. */
const READ = /^(list|get|search|check|detect|validate|resolve|quote|decode|download)/;
/** Money calls carry an idempotency key, so a lost response can be retried safely. */
const hasIdempotencyKey = (input: unknown) =>
  typeof input === 'object' && input !== null && 'idempotencyKey' in input;
/** Ambient activity: about one incoming transfer a minute at a 1 s pulse. */
const AMBIENT_CHANCE = 1 / 60;

/**
 * Data crosses the boundary as JSON, like it would over HTTP: callers can never
 * hold (or mutate) the bank's own objects, and cached results never change under
 * TanStack Query's feet.
 */
const copy = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);

/**
 * The on-device mock bank behind the repository interfaces. It loads (or seeds) on
 * first use, simulates the network (T3.8), runs background work before each call
 * and on a pulse, saves every change, and publishes realtime events.
 */
export function createMockBank(options: MockOptions = {}): MockBankHandle {
  const store = options.store ?? createDeviceStore();
  const clock = options.clock ?? (() => new Date());
  const random = options.random ?? Math.random;
  const simulation = createSimulation(options.simulation);
  const events = createEmitter<RealtimeEvent>();
  const statuses = createEmitter<RealtimeStatus>();
  let status: RealtimeStatus = 'closed';
  let current: Promise<{ bank: MockBank; repos: Repositories }> | null = null;

  const open = async (fresh: boolean) => {
    const load = fresh ? resetBank : loadOrSeedBank;
    const state = await load(store, { now: clock(), seed: options.seed ?? DEFAULT_SEED });
    const bank = new MockBank(state, store, clock, async () => {
      current = open(true);
      await current;
    });
    return { bank, repos: buildMockDomains(bank) };
  };
  const ready = () => (current ??= open(false));

  /** Runs `work`, then saves and publishes whatever it changed. */
  const observe = async <T>(
    work: (bank: MockBank, repos: Repositories) => Promise<T>,
    write: boolean,
  ) => {
    const running = ready();
    const { bank, repos } = await running;
    const before = fingerprint(bank);
    const ticked = bank.tick();
    try {
      return await work(bank, repos);
    } finally {
      // After a Demo Controls reset the old bank must not overwrite the new one.
      if (current === running) {
        if (ticked || write) await bank.save();
        const changes = diffEvents(bank, before, fingerprint(bank));
        if (events.size > 0) for (const event of changes) events.emit(copy(event));
      }
    }
  };

  const dispatch: Dispatcher = async ({ domain, method, input, options: call }) => {
    const settings = simulation.get();
    const write = !READ.test(method);
    if (settings.offline) throw offlineError();
    await sleep(latencyFor(settings.latency, write, random), call?.signal);
    if (simulation.get().offline) throw offlineError();
    if (random() < settings.errorRate) throw injectedError();
    const result = await observe((_bank, repos) => {
      const fn = (
        repos[domain] as Record<string, (i: unknown, o?: CallOptions) => Promise<unknown>>
      )[method]!;
      return fn(copy(input), call);
    }, write);
    // The work is done and saved; only the answer is "lost". Same key = replay.
    if (
      settings.failAfterCommit &&
      hasIdempotencyKey(input) &&
      random() < Math.max(settings.errorRate, 0.5)
    ) {
      throw timeoutError();
    }
    return copy(result);
  };

  const pulse = async () => {
    const collected: RealtimeEvent[] = [];
    const stop = events.subscribe((e) => collected.push(e));
    try {
      await observe(async (bank) => {
        if (simulation.get().ambientActivity && random() < AMBIENT_CHANCE)
          ambientIncoming(bank, random);
      }, false);
    } finally {
      stop();
    }
    return collected;
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  const setStatus = (next: RealtimeStatus) => {
    if (next === status) return;
    status = next;
    statuses.emit(next);
  };
  const connect = () => {
    if (simulation.get().offline) return setStatus('closed');
    setStatus('connecting');
    void ready().then(() => {
      if (events.size === 0 || simulation.get().offline) return;
      setStatus('open');
      timer ??= setInterval(() => void pulse().catch(() => undefined), options.pulseMs ?? 1_000);
    });
  };
  const disconnect = () => {
    if (timer) clearInterval(timer);
    timer = null;
    setStatus('closed');
  };
  simulation.subscribe((s) => {
    if (s.offline) disconnect();
    else if (events.size > 0 && status === 'closed') connect();
  });

  const realtime: RealtimeSource = {
    subscribe(listener) {
      const unsubscribe = events.subscribe(listener);
      if (events.size === 1) connect();
      return () => {
        unsubscribe();
        if (events.size === 0) disconnect();
      };
    },
    status: () => status,
    onStatus: statuses.subscribe,
  };

  return { repositories: repositoriesFromDispatcher(dispatch), realtime, simulation, pulse };
}

/** Repositories only, for callers that do not need realtime or Demo Controls. */
export function createMockRepositories(options: MockOptions = {}): Repositories {
  return createMockBank(options).repositories;
}
