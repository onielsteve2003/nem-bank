import { create } from 'zustand';

// Whether the real bank (the Go API) is awake. Not persisted: every launch asks again,
// so a demo fallback never traps someone on the mock bank once the API is back.

export type BankStatus =
  /** Mock mode, or demo fallback: nothing to wait for. */
  | 'idle'
  /** Probing; shown silently for the first moments. */
  | 'checking'
  /** Taking long: the host is waking from sleep (cold start). */
  | 'waking'
  | 'ready'
  /** Gave up waiting. */
  | 'unreachable';

export interface BankState {
  status: BankStatus;
  /** The person chose to carry on with the on-device demo bank instead. */
  demoFallback: boolean;
  /** When the bank last answered; keep-warm and the foreground check read it. */
  lastOkAt: number | null;
  /** Bumped to run another wake-up round. */
  round: number;
  begin: () => void;
  markWaking: () => void;
  markReady: (at?: number) => void;
  markUnreachable: () => void;
  retry: () => void;
  fallBackToDemo: () => void;
}

export const useBankStore = create<BankState>()((set) => ({
  status: 'idle',
  demoFallback: false,
  lastOkAt: null,
  round: 0,
  // A round that starts while the overlay is up keeps it up ("try again" must not flash the app).
  begin: () =>
    set((s) => ({
      status: s.status === 'waking' || s.status === 'unreachable' ? 'waking' : 'checking',
    })),
  // Only a round in progress can turn slow; a late callback must not undo "ready".
  markWaking: () => set((s) => (s.status === 'checking' ? { status: 'waking' } : s)),
  markReady: (at = Date.now()) => set({ status: 'ready', lastOkAt: at }),
  markUnreachable: () => set({ status: 'unreachable' }),
  retry: () => set((s) => ({ round: s.round + 1 })),
  fallBackToDemo: () => set({ demoFallback: true, status: 'idle' }),
}));

/** The overlay is up while the bank is waking or gave up. */
export const useBankBlocked = () =>
  useBankStore((s) => s.status === 'waking' || s.status === 'unreachable');
