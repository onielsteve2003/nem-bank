/** Where the mock bank keeps its snapshot: SQLite on devices, localStorage on web. */
export interface SnapshotStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** In-memory store for tests and for browsers that block storage. */
export function createMemoryStore(initial: Record<string, string> = {}): SnapshotStore {
  const data = new Map(Object.entries(initial));
  return {
    read: async (key) => data.get(key) ?? null,
    write: async (key, value) => {
      data.set(key, value);
    },
    remove: async (key) => {
      data.delete(key);
    },
  };
}
