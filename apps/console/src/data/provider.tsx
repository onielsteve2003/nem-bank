import type { StaffRole, StaffSession } from '@nem/contracts';
import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { currentAccessToken } from '@/features/auth/session';

import { createMockDispatcher, type MockOptions } from './mock';
import { switchDemoRole } from './mock/auth';
import { createMockState, findAccountByEmail } from './mock/state';
import { repositoriesFromDispatcher, type Repositories } from './repositories';

/** Shortcuts that only exist in the demo, never against the real API. */
export interface DemoControls {
  switchRole: (role: StaffRole) => StaffSession;
  /** The seeded authenticator secret for a demo account, for the on-page authenticator. */
  totpSecretFor: (email: string) => string | null;
}

interface DataValue {
  repositories: Repositories;
  demo: DemoControls | null;
}

const DataContext = createContext<DataValue | null>(null);

type Props = {
  children: ReactNode;
  /** Tests pass their own mock options (state, latency). */
  mock?: MockOptions;
};

/**
 * Pages reach data through feature hooks → TanStack Query → these repositories, never
 * fetch. Phase 2 adds an http dispatcher chosen by VITE_API_MODE; until then it is mock.
 */
export function RepositoryProvider({ children, mock }: Props) {
  const value = useMemo<DataValue>(() => {
    const state = mock?.state ?? createMockState();
    const dispatch = createMockDispatcher({
      getAccessToken: currentAccessToken,
      ...mock,
      state,
    });
    return {
      repositories: repositoriesFromDispatcher(dispatch),
      demo: {
        switchRole: (role) => switchDemoRole(state, role),
        totpSecretFor: (email) => findAccountByEmail(state, email)?.totpSecret ?? null,
      },
    };
  }, [mock]);
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

function useData(): DataValue {
  const value = useContext(DataContext);
  if (!value) throw new Error('data hooks must be used inside RepositoryProvider');
  return value;
}

export const useRepositories = (): Repositories => useData().repositories;
export const useDemoControls = (): DemoControls | null => useData().demo;
