import type { Schema } from '@nem/contracts';
import { create } from 'zustand';

/**
 * The sign-up in progress between steps (details → verify email → password and
 * PIN). Held in memory only: personal details never touch disk before the
 * account exists, and an app restart starts sign-up again.
 */
export interface PendingSignup extends Schema<'SignupStarted'> {
  request: Schema<'SignupRequest'>;
  /** Proof the email was verified, sent with the password to finish sign-up. */
  verificationToken?: string;
  /** Chosen in steps 3 and 4 and sent together, so no account exists without a PIN. */
  password?: string;
  pin?: string;
}

interface SignupState {
  pending: PendingSignup | null;
  start: (started: Schema<'SignupStarted'>, request: Schema<'SignupRequest'>) => void;
  /** A resent code replaces the challenge (new expiry, cooldown and attempts). */
  setOtp: (otp: Schema<'OtpChallenge'>) => void;
  verified: (token: string) => void;
  setPassword: (password: string) => void;
  setPin: (pin: string) => void;
  clear: () => void;
}

export const useSignupStore = create<SignupState>()((set) => ({
  pending: null,
  start: (started, request) => set({ pending: { ...started, request } }),
  setOtp: (otp) => set((s) => (s.pending ? { pending: { ...s.pending, otp } } : s)),
  verified: (verificationToken) =>
    set((s) => (s.pending ? { pending: { ...s.pending, verificationToken } } : s)),
  setPassword: (password) => set((s) => (s.pending ? { pending: { ...s.pending, password } } : s)),
  setPin: (pin) => set((s) => (s.pending ? { pending: { ...s.pending, pin } } : s)),
  clear: () => set({ pending: null }),
}));
