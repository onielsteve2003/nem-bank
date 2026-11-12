import type { StaffRole, StaffSession } from '@nem/contracts';
import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { currentAccessToken } from '@/features/auth/session';
import { developerTokens } from '@/features/developer/developerSession';
import { env as appEnv, type Env } from '@/lib/env';

import { createHttpDispatcher } from './http/client';
import { createMockDispatcher, type MockOptions } from './mock';
import { tamperAudit } from './mock/audit';
import { switchDemoRole } from './mock/auth';
import { developerStepUp } from './mock/developer';
import { createMockState, findAccountByEmail } from './mock/state';
import { repositoriesFromDispatcher, type Repositories } from './repositories';

/** Shortcuts that only exist in the demo, never against the real API. */
export interface DemoControls {
  switchRole: (role: StaffRole) => StaffSession;
  /** The seeded authenticator secret for a demo account, for the on-page authenticator. */
  totpSecretFor: (email: string) => string | null;
  /** Edits an audit entry without re-hashing it, so verify has a break to find. */
  tamperAudit: () => number;
  /** The Merchant Simulator's test cards, with the details a merchant would type. */
  testCards: () => TestCard[];
  /** Checks the demo business PIN and returns a step-up token (POST /v1/auth/step-up in Phase 2). */
  developerStepUp: (pin: string) => string | null;
}

export interface TestCard {
  id: string;
  label: string;
  purpose: string;
  pan: string;
  cvv: string;
  expiryMonth: number;
  expiryYear: number;
  currency: 'NGN' | 'USD';
}

interface DataValue {
  repositories: Repositories;
  demo: DemoControls | null;
  /** The API's origin, or null on the mock bank. Links the API serves are relative to it. */
  apiUrl: string | null;
}

const DataContext = createContext<DataValue | null>(null);

type Props = {
  children: ReactNode;
  /** Tests pass their own mock options (state, latency). */
  mock?: MockOptions;
  /** Overrides the build's environment (tests). */
  env?: Env;
};

/** Repositories over the Go API; no demo shortcuts exist against the real bank. */
function httpData(apiUrl: string): DataValue {
  const dispatch = createHttpDispatcher({
    baseUrl: apiUrl,
    staffToken: currentAccessToken,
    customer: developerTokens,
  });
  return { repositories: repositoriesFromDispatcher(dispatch), demo: null, apiUrl };
}

/**
 * Pages reach data through feature hooks → TanStack Query → these repositories, never
 * fetch. VITE_API_MODE picks the dispatcher: the in-browser mock bank (default) or the
 * Go API.
 */
export function RepositoryProvider({ children, mock, env = appEnv }: Props) {
  const value = useMemo<DataValue>(() => {
    if (env.apiMode === 'http' && !mock) return httpData(env.apiUrl);
    const state = mock?.state ?? createMockState();
    const dispatch = createMockDispatcher({
      getAccessToken: currentAccessToken,
      ...mock,
      state,
    });
    return {
      repositories: repositoriesFromDispatcher(dispatch),
      apiUrl: null,
      demo: {
        switchRole: (role) => switchDemoRole(state, role),
        totpSecretFor: (email) => findAccountByEmail(state, email)?.totpSecret ?? null,
        tamperAudit: () => tamperAudit(state),
        developerStepUp: (pin) => developerStepUp(state, pin),
        testCards: () =>
          state.simulators.cards.map(({ card, pan, cvv, purpose }) => ({
            id: card.id,
            label: `${card.name_on_card} · ${card.currency} ${card.type.replace('_', ' ')} ·${card.last4}`,
            purpose: card.status === 'used' ? `${purpose} (used)` : purpose,
            pan,
            cvv,
            expiryMonth: card.expiry_month,
            expiryYear: card.expiry_year,
            currency: card.currency,
          })),
      },
    };
  }, [mock, env]);
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

function useData(): DataValue {
  const value = useContext(DataContext);
  if (!value) throw new Error('data hooks must be used inside RepositoryProvider');
  return value;
}

export const useRepositories = (): Repositories => useData().repositories;
export const useDemoControls = (): DemoControls | null => useData().demo;
export const useApiUrl = (): string | null => useData().apiUrl;
