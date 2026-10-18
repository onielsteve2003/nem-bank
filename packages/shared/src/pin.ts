import { z } from 'zod';

/** PINs are 4 or 6 digits (AUTH-4). */
export const PIN_LENGTHS = [4, 6] as const;

/**
 * Rejects PINs that are guessed first: one repeated digit (1111) and straight runs
 * up or down (1234, 987654). Used by the PIN form and by the mock bank.
 */
export function isWeakPin(pin: string): boolean {
  const digits = [...pin].map(Number);
  if (digits.every((d) => d === digits[0])) return true;
  const steps = digits.slice(1).map((d, i) => d - digits[i]!);
  return steps.every((s) => s === 1) || steps.every((s) => s === -1);
}

export const pinSchema = z
  .string()
  .regex(/^(\d{4}|\d{6})$/, 'Use 4 or 6 digits')
  .refine((pin) => !isWeakPin(pin), 'Pick a PIN that is harder to guess');
