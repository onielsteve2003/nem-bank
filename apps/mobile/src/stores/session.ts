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
  /** Lower outgoing limits until then: this device signed in for the first time (AUTH-8). */
  coolOffUntil: string | null;
  /** Show the "new device signed in" notice once, after a login that bound this device. */
  newDeviceNotice: boolean;
  /** No @nemtag yet: the app opens on the chooser until one is set (AUTH-10). */
  needsNemtag: boolean;
}

/** `restoring` until SecureStore has been read on launch. */
export type SessionStatus = 'restoring' | 'signedOut' | 'signedIn';

/** Why the last session ended: the user signed out, or the bank ended it. */
export type SessionEnd = 'signedOut' | 'expired';

export interface SessionState {
  status: SessionStatus;
  session: StoredSession | null;
  /**
   * Sign-in and every token refresh (refresh tokens rotate on each use). `newDevice`
   * marks a login that bound this device; a refresh keeps the notice as it was.
   */
  setSession: (auth: AuthSession, options?: { newDevice?: boolean }) => void;
  dismissNewDeviceNotice: () => void;
  nemtagChosen: () => void;
  signOut: () => void;
  /** The refresh token ran out or was revoked: back to sign-in, saying why (T4.6). */
  expire: () => void;
  endedBy: SessionEnd | null;
}

export function toStoredSession(auth: AuthSession, newDeviceNotice = false): StoredSession {
  return {
    accessToken: auth.access_token,
    accessTokenExpiresAt: auth.access_token_expires_at,
    refreshToken: auth.refresh_token,
    refreshTokenExpiresAt: auth.refresh_token_expires_at,
    userId: auth.user.id,
    deviceId: auth.device.id,
    isDemo: auth.user.is_demo,
    coolOffUntil: auth.device.cool_off_until ?? null,
    newDeviceNotice,
    needsNemtag: auth.user.nemtag === null,
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
      setSession: (auth, options) =>
        set((s) => ({
          status: 'signedIn',
          session: toStoredSession(auth, options?.newDevice ?? s.session?.newDeviceNotice === true),
          endedBy: null,
        })),
      nemtagChosen: () =>
        set((s) => (s.session ? { session: { ...s.session, needsNemtag: false } } : s)),
      dismissNewDeviceNotice: () =>
        set((s) => (s.session ? { session: { ...s.session, newDeviceNotice: false } } : s)),
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
      // Restore runs in `merge`, not onRehydrateStorage: web storage is synchronous, so
      // hydration happens inside `create()` before `useSessionStore` exists, and a
      // throwing callback leaves the store never hydrated (a blank app).
      merge: (persisted, current) => {
        const session = (persisted as Partial<SessionState> | undefined)?.session ?? null;
        // A session whose refresh token has expired cannot be revived: start signed out.
        if (session && canRefresh(session)) return { ...current, status: 'signedIn', session };
        // A stored session that lapsed while the app was closed has expired too.
        return {
          ...current,
          status: 'signedOut',
          session: null,
          endedBy: session ? 'expired' : null,
        };
      },
    },
  ),
);
