import type { AuthSession } from '@nem/contracts';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { secureStorage } from '@/lib/secureStorage';

// Who is signed in, and the tokens to prove it. Persisted in SecureStore only; the
// user's profile is server data and lives in TanStack Query, not here.

/** Refresh this long before expiry so a request never leaves with a dying token. */
export const ACCESS_TOKEN_SKEW_MS = 30_000;

export interface StoredSession {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  userId: string;
  deviceId: string;
  isDemo: boolean;
}

/** `restoring` until SecureStore has been read on launch. */
export type SessionStatus = 'restoring' | 'signedOut' | 'signedIn';

/** Why the last session ended: the user signed out, or the bank ended it. */
export type SessionEnd = 'signedOut' | 'expired';

export interface SessionState {
  status: SessionStatus;
  session: StoredSession | null;
  /** Sign-in and every token refresh (refresh tokens rotate on each use). */
  setSession: (auth: AuthSession) => void;
  signOut: () => void;
  /** The refresh token ran out or was revoked: back to sign-in, saying why (T4.6). */
  expire: () => void;
  endedBy: SessionEnd | null;
}

export function toStoredSession(auth: AuthSession): StoredSession {
  return {
    accessToken: auth.access_token,
    accessTokenExpiresAt: auth.access_token_expires_at,
    refreshToken: auth.refresh_token,
    refreshTokenExpiresAt: auth.refresh_token_expires_at,
    userId: auth.user.id,
    deviceId: auth.device.id,
    isDemo: auth.user.is_demo,
  };
}

export function isAccessTokenFresh(session: StoredSession, now: number = Date.now()): boolean {
  return Date.parse(session.accessTokenExpiresAt) - ACCESS_TOKEN_SKEW_MS > now;
}

export function canRefresh(session: StoredSession, now: number = Date.now()): boolean {
  return Date.parse(session.refreshTokenExpiresAt) > now;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      status: 'restoring',
      session: null,
      endedBy: null,
      setSession: (auth) =>
        set({ status: 'signedIn', session: toStoredSession(auth), endedBy: null }),
      signOut: () => set({ status: 'signedOut', session: null, endedBy: 'signedOut' }),
      expire: () =>
        set((s) =>
          s.status === 'signedIn' ? { status: 'signedOut', session: null, endedBy: 'expired' } : s,
        ),
    }),
    {
      name: 'nem.session',
      version: 1,
      storage: createJSONStorage(() => secureStorage),
      partialize: (state) => ({ session: state.session }),
      // A session whose refresh token has expired cannot be revived: start signed out.
      onRehydrateStorage: () => (state) => {
        const session = state?.session ?? null;
        if (session && canRefresh(session)) {
          useSessionStore.setState({ status: 'signedIn' });
        } else {
          // A stored session that lapsed while the app was closed has expired too.
          useSessionStore.setState({
            status: 'signedOut',
            session: null,
            endedBy: session ? 'expired' : null,
          });
        }
      },
    },
  ),
);
