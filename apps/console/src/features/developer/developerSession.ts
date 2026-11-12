import type { AuthSession, Schema } from '@nem/contracts';
import { create } from 'zustand';

import type { CustomerTokens } from '@/data/http/client';

// The developer portal signs in as a business *customer* (the API's developer routes are
// customer routes), separate from the staff session. Like the staff token, it lives in
// sessionStorage so a reload keeps it and closing the tab ends it.

const SESSION_KEY = 'nem-console-developer-session';
const DEVICE_KEY = 'nem-console-developer-device';

function loadSession(): AuthSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as AuthSession) : null;
  } catch {
    return null;
  }
}

function saveSession(session: AuthSession | null): void {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage blocked: the session still works until the page reloads.
  }
}

interface DeveloperSessionState {
  session: AuthSession | null;
  signIn: (session: AuthSession) => void;
  signOut: () => void;
}

export const useDeveloperSession = create<DeveloperSessionState>((set) => ({
  session: loadSession(),
  signIn: (session) => {
    saveSession(session);
    set({ session });
  },
  signOut: () => {
    saveSession(null);
    set({ session: null });
  },
}));

/** What the http dispatcher reads and rotates. */
export const developerTokens: CustomerTokens = {
  get: () => useDeveloperSession.getState().session,
  save: (session) => useDeveloperSession.getState().signIn(session),
  clear: () => useDeveloperSession.getState().signOut(),
};

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The device this browser signs in as. The API wants a 32-byte public key for every
 * device; the console never signs money requests, so the key is random bytes kept only
 * to reuse the same device on the next sign-in (the API matches a device by its key).
 */
export function browserDevice(): Schema<'DeviceRegistration'> {
  let key: string | null = null;
  try {
    key = localStorage.getItem(DEVICE_KEY);
  } catch {
    key = null;
  }
  if (!key) {
    key = base64url(crypto.getRandomValues(new Uint8Array(32)));
    try {
      localStorage.setItem(DEVICE_KEY, key);
    } catch {
      // Private mode: this sign-in registers a fresh device, which is harmless.
    }
  }
  return {
    name: 'Developer portal (web)',
    platform: 'web',
    public_key: key,
    hardware_backed: false,
  };
}
