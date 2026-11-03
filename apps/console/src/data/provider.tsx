import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { createMockDispatcher, type MockOptions } from './mock';
import { repositoriesFromDispatcher, type Repositories } from './repositories';

const RepositoryContext = createContext<Repositories | null>(null);

type Props = {
  children: ReactNode;
  /** Tests pass their own repositories or mock options. */
  repositories?: Repositories;
  mock?: MockOptions;
};

/**
 * Pages reach data through feature hooks → TanStack Query → these repositories, never
 * fetch. Phase 2 adds an http dispatcher chosen by VITE_API_MODE; until then it is mock.
 */
export function RepositoryProvider({ children, repositories, mock }: Props) {
  const value = useMemo(
    () => repositories ?? repositoriesFromDispatcher(createMockDispatcher(mock)),
    [repositories, mock],
  );
  return <RepositoryContext.Provider value={value}>{children}</RepositoryContext.Provider>;
}

export function useRepositories(): Repositories {
  const value = useContext(RepositoryContext);
  if (!value) throw new Error('useRepositories must be used inside RepositoryProvider');
  return value;
}
