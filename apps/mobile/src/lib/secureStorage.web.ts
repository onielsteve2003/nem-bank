import type { StateStorage } from 'zustand/middleware';

// The browser has no secure enclave. The web demo keeps secrets in sessionStorage:
// they survive a reload but die with the tab, and never reach localStorage.

const memory = new Map<string, string>();

function session(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null; // Blocked storage (privacy mode, sandboxed iframe).
  }
}

export const secureStorage: StateStorage = {
  getItem: (key) => session()?.getItem(key) ?? memory.get(key) ?? null,
  setItem: (key, value) => {
    const store = session();
    if (store) store.setItem(key, value);
    else memory.set(key, value);
  },
  removeItem: (key) => {
    session()?.removeItem(key);
    memory.delete(key);
  },
};
