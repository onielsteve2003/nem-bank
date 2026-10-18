import { useSessionStore } from '@/stores/session';

import type { TokenStore } from './client';

/** The http client's tokens come from, and go back to, the session store (T3.10). */
export const sessionTokens: TokenStore = {
  get: () => useSessionStore.getState().session,
  save: (session) => useSessionStore.getState().setSession(session),
  expire: () => useSessionStore.getState().expire(),
};
