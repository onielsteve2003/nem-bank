import type { StaffSession } from '@nem/contracts';
import { create } from 'zustand';

// Staff sessions last 8 hours with no refresh (contract). The token lives in
// sessionStorage so a reload keeps you signed in, but closing the tab ends it and no
// other tab or later visit can pick it up.

const STORAGE_KEY = 'nem-console-session';

function load(): StaffSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StaffSession) : null;
  } catch {
    return null;
  }
}

function save(session: StaffSession | null): void {
  try {
    if (session) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked: the session still works until the page reloads.
  }
}

export function isActive(session: StaffSession | null, nowMs = Date.now()): boolean {
  return session !== null && Date.parse(session.expires_at) > nowMs;
}

interface SessionState {
  session: StaffSession | null;
  signIn: (session: StaffSession) => void;
  signOut: () => void;
}

export const useSession = create<SessionState>((set) => ({
  session: load(),
  signIn: (session) => {
    save(session);
    set({ session });
  },
  signOut: () => {
    save(null);
    set({ session: null });
  },
}));

/** The signed-in staff member's token, or null once it has expired. */
export function currentAccessToken(): string | null {
  const { session } = useSession.getState();
  return isActive(session) ? (session?.access_token ?? null) : null;
}
