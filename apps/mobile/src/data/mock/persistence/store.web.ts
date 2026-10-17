import { createMemoryStore, type SnapshotStore } from './types';

const PREFIX = 'nem-mock-bank:';

function localStorageOrNull(): Storage | null {
  try {
    const storage = globalThis.localStorage;
    const probe = `${PREFIX}probe`;
    storage.setItem(probe, probe);
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

/**
 * The web demo keeps the snapshot in localStorage: expo-sqlite on web needs
 * cross-origin isolation headers, which a static Vercel demo should not depend on.
 * Private windows that block storage fall back to memory (the demo still works,
 * it just starts fresh on reload).
 */
export function createDeviceStore(): SnapshotStore {
  const storage = localStorageOrNull();
  if (!storage) return createMemoryStore();
  return {
    read: async (key) => storage.getItem(PREFIX + key),
    write: async (key, value) => storage.setItem(PREFIX + key, value),
    remove: async (key) => storage.removeItem(PREFIX + key),
  };
}
