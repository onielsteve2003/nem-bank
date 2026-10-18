import type { CallOptions } from '../contract';
import type { Dispatcher } from '../dispatch';
import { repositoriesFromDispatcher } from '../dispatch';
import type { Repositories } from '../repositories';
import { DEFAULT_SEED, loadOrSeedBank, resetBank } from './bank';
import { buildMockDomains } from './domains';
import { createDeviceStore } from './persistence/store';
import type { SnapshotStore } from './persistence/types';
import { MockBank } from './runtime';

export { DEMO_OTP, DEMO_PASSWORD } from './domains/auth';

export interface MockOptions {
  /** Where the bank is saved; SQLite on devices, localStorage on web by default. */
  store?: SnapshotStore;
  /** The device clock; Demo Controls time travel is added on top. */
  clock?: () => Date;
  seed?: number;
}

/** Calls that only read: no save unless background work changed something. */
const READ = /^(list|get|search|check|detect|validate|resolve|quote|decode|download)/;

/**
 * Data crosses the boundary as JSON, like it would over HTTP: callers can never
 * hold (or mutate) the bank's own objects, and cached results never change under
 * TanStack Query's feet.
 */
const copy = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);

/**
 * Repositories backed by the on-device mock bank. The bank loads (or seeds) on the
 * first call, background work (partner callbacks, schedules) runs before each call,
 * and every change is saved.
 */
export function createMockRepositories(options: MockOptions = {}): Repositories {
  const store = options.store ?? createDeviceStore();
  const clock = options.clock ?? (() => new Date());
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

  const dispatch: Dispatcher = async ({ domain, method, input, options: call }) => {
    current ??= open(false);
    const running = current;
    const { bank, repos } = await running;
    call?.signal?.throwIfAborted();
    const ticked = bank.tick();
    const fn = (repos[domain] as Record<string, (i: unknown, o?: CallOptions) => Promise<unknown>>)[
      method
    ]!;
    try {
      return copy(await fn(copy(input), call));
    } finally {
      // After a Demo Controls reset the old bank must not overwrite the new one.
      if (current === running && (ticked || !READ.test(method))) await bank.save();
    }
  };

  return repositoriesFromDispatcher(dispatch);
}
