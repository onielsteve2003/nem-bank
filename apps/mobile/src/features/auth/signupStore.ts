import type { Schema } from '@nem/contracts';
import { create } from 'zustand';

/**
 * The sign-up in progress between steps (details → verify email → password and
 * PIN). Held in memory only: personal details never touch disk before the
 * account exists, and an app restart starts sign-up again.
 */
interface SignupState {
  pending: (Schema<'SignupStarted'> & { request: Schema<'SignupRequest'> }) | null;
  start: (started: Schema<'SignupStarted'>, request: Schema<'SignupRequest'>) => void;
  clear: () => void;
}

export const useSignupStore = create<SignupState>()((set) => ({
  pending: null,
  start: (started, request) => set({ pending: { ...started, request } }),
  clear: () => set({ pending: null }),
}));
