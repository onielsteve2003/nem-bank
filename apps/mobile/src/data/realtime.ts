import type { RealtimeEvent } from '@nem/contracts';

// The realtime channel as the app sees it: events from the server's WebSocket
// (Phase 2) or from the mock bank, behind one interface.

export type RealtimeStatus = 'connecting' | 'open' | 'closed';

export interface RealtimeSource {
  /** Receives every event; the channel opens on the first listener. */
  subscribe(listener: (event: RealtimeEvent) => void): () => void;
  status(): RealtimeStatus;
  onStatus(listener: (status: RealtimeStatus) => void): () => void;
}

/** A tiny synchronous pub/sub. One failing listener never stops the others. */
export function createEmitter<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    emit(value: T) {
      for (const listener of [...listeners]) {
        try {
          listener(value);
        } catch (error) {
          console.error('Realtime listener failed', error);
        }
      }
    },
    subscribe(listener: (value: T) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get size() {
      return listeners.size;
    },
  };
}

/** Until the WebSocket client lands (Phase 2), http mode has no realtime events. */
export const silentRealtime: RealtimeSource = {
  subscribe: () => () => undefined,
  status: () => 'closed',
  onStatus: () => () => undefined,
};
