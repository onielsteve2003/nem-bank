import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { env as appEnv, type Env } from '@/lib/env';

import { createHttpRepositories } from './http';
import { createMockRepositories } from './mock';
import type { Domain, Repositories } from './repositories';

/** Picks the data source from `EXPO_PUBLIC_API_MODE`; mock is the default. */
export function createRepositories(env: Env): Repositories {
  return env.apiMode === 'http'
    ? createHttpRepositories({ baseUrl: env.apiUrl })
    : createMockRepositories();
}

const RepositoryContext = createContext<Repositories | null>(null);

export interface Props {
  children: ReactNode;
  /** Injects repositories directly (tests, storybook-style previews). */
  repositories?: Repositories;
  /** Overrides the app environment when `repositories` is not given. */
  env?: Env;
}

export function RepositoryProvider({ children, repositories, env = appEnv }: Props) {
  const value = useMemo(() => repositories ?? createRepositories(env), [repositories, env]);
  return <RepositoryContext.Provider value={value}>{children}</RepositoryContext.Provider>;
}

export function useRepositories(): Repositories {
  const repositories = useContext(RepositoryContext);
  if (!repositories) throw new Error('useRepositories must be used inside <RepositoryProvider>');
  return repositories;
}

export function useRepository<D extends Domain>(domain: D): Repositories[D] {
  return useRepositories()[domain];
}
