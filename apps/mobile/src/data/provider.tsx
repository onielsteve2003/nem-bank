import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { deviceSigner } from '@/lib/deviceKey';
import { env as appEnv, type Env } from '@/lib/env';
import { useBankStore } from '@/stores/bank';
import { useSessionStore } from '@/stores/session';

import { createHttpRepositories, sessionTokens } from './http';
import { createMockBank, type Simulation } from './mock';
import { silentRealtime, type RealtimeSource } from './realtime';
import { createSocketRealtime } from './socketRealtime';
import type { Domain, Repositories } from './repositories';

/** Everything the app reads data through: repositories, realtime, and (mock only) network simulation. */
export interface DataLayer {
  repositories: Repositories;
  realtime: RealtimeSource;
  /** Demo Controls' network conditions; `null` against the real API. */
  simulation: Simulation | null;
}

/** Picks the data source from `EXPO_PUBLIC_API_MODE`; mock is the default. */
export function createDataLayer(env: Env): DataLayer {
  if (env.apiMode === 'http') {
    const repositories = createHttpRepositories({
      baseUrl: env.apiUrl,
      tokens: sessionTokens,
      signer: deviceSigner,
    });
    const realtime = createSocketRealtime({
      getTicket: () => repositories.realtime.createTicket({}),
    });
    // The socket follows the session: open while signed in, closed otherwise.
    const follow = (status: string) => realtime.setActive(status === 'signedIn');
    follow(useSessionStore.getState().status);
    useSessionStore.subscribe((state) => follow(state.status));
    return { repositories, realtime, simulation: null };
  }
  const { repositories, realtime, simulation } = createMockBank();
  return { repositories, realtime, simulation };
}

export function createRepositories(env: Env): Repositories {
  return createDataLayer(env).repositories;
}

const DataContext = createContext<DataLayer | null>(null);

export interface Props {
  children: ReactNode;
  /** Injects repositories directly (tests, storybook-style previews). */
  repositories?: Repositories;
  /** Injects a realtime source; silent when repositories are injected without one. */
  realtime?: RealtimeSource;
  /** Injects the mock bank's network simulation alongside injected repositories. */
  simulation?: Simulation | null;
  /** Overrides the app environment when `repositories` is not given. */
  env?: Env;
}

export function RepositoryProvider({
  children,
  repositories,
  realtime,
  simulation = null,
  env = appEnv,
}: Props) {
  // "Use the demo bank instead" (T31.4) swaps the real API for the on-device mock bank.
  const demoFallback = useBankStore((s) => s.demoFallback);
  const value = useMemo<DataLayer>(
    () =>
      repositories
        ? { repositories, realtime: realtime ?? silentRealtime, simulation }
        : createDataLayer(demoFallback ? { apiMode: 'mock', apiUrl: env.apiUrl } : env),
    [repositories, realtime, simulation, env, demoFallback],
  );
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

function useDataLayer(): DataLayer {
  const layer = useContext(DataContext);
  if (!layer) throw new Error('useRepositories must be used inside <RepositoryProvider>');
  return layer;
}

export function useRepositories(): Repositories {
  return useDataLayer().repositories;
}

export function useRepository<D extends Domain>(domain: D): Repositories[D] {
  return useRepositories()[domain];
}

export function useRealtime(): RealtimeSource {
  return useDataLayer().realtime;
}

export function useSimulation(): Simulation | null {
  return useDataLayer().simulation;
}
