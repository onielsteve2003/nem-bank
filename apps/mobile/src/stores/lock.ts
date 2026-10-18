import { create } from 'zustand';

import { useSessionStore } from './session';

// App lock (AUTH-12). Not persisted on purpose: every cold start with a restored
// session begins locked, so a killed app is no shortcut past the PIN.

export interface LockState {
  locked: boolean;
  /** True while the system biometric prompt is up, so the privacy cover stays off it. */
  authenticating: boolean;
  lock: () => void;
  unlock: () => void;
  setAuthenticating: (on: boolean) => void;
}

export const useLockStore = create<LockState>()((set) => ({
  locked: true,
  authenticating: false,
  lock: () => set({ locked: true }),
  unlock: () => set({ locked: false }),
  setAuthenticating: (authenticating) => set({ authenticating }),
}));

// Signing in has just proven who the user is, so a fresh sign-in starts unlocked.
// Restoring a stored session at launch (restoring → signedIn) does not.
useSessionStore.subscribe((state, prev) => {
  if (prev.status === 'signedOut' && state.status === 'signedIn') {
    useLockStore.getState().unlock();
  }
});

/** The lock screen shows only for a signed-in user. */
export function useAppLocked(): boolean {
  const locked = useLockStore((s) => s.locked);
  const signedIn = useSessionStore((s) => s.status === 'signedIn');
  return locked && signedIn;
}
