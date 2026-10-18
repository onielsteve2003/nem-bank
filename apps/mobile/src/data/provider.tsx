import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { env as appEnv, type Env } from '@/lib/env';

import { createHttpRepositories } from './http';
import { createMockBank, type Simulation } from './mock';
import { silentRealtime, type RealtimeSource } from './realtime';
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
    return {
      repositories: createHttpRepositories({ baseUrl: env.apiUrl }),
      realtime: silentRealtime,
      simulation: null,
    };
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
  const value = useMemo<DataLayer>(
    () =>
      repositories
        ? { repositories, realtime: realtime ?? silentRealtime, simulation }
        : createDataLayer(env),
    [repositories, realtime, simulation, env],
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
