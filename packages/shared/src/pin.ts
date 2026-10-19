import { z } from 'zod';

/** PINs are 4 or 6 digits (AUTH-4). */
export const PIN_LENGTHS = [4, 6] as const;

/**
 * Rejects PINs that are guessed first: one repeated digit (1111) and straight runs
 * up or down (1234, 987654), plus date-of-birth PINs when the date is known. Used by the PIN form and by the mock bank.
 */
export function isWeakPin(pin: string, dateOfBirth?: string): boolean {
  if (dateOfBirth && isDateOfBirthPin(pin, dateOfBirth)) return true;
  const digits = [...pin].map(Number);
  if (digits.every((d) => d === digits[0])) return true;
  const steps = digits.slice(1).map((d, i) => d - digits[i]!);
  return steps.every((s) => s === 1) || steps.every((s) => s === -1);
}

/**
 * The birthday PINs a thief with the owner's ID card tries first (AUTH-4):
 * the year, day+month either way round, and the 6-digit date forms.
 * `dateOfBirth` is ISO, YYYY-MM-DD.
 */
export function isDateOfBirthPin(pin: string, dateOfBirth: string): boolean {
  const [yyyy, mm, dd] = dateOfBirth.split('-');
  if (!yyyy || !mm || !dd) return false;
  const yy = yyyy.slice(2);
  const forms = [yyyy, dd + mm, mm + dd, mm + yy, dd + mm + yy, mm + dd + yy, yy + mm + dd];
  return forms.includes(pin);
}

export const pinSchema = z
  .string()
  .regex(/^(\d{4}|\d{6})$/, 'Use 4 or 6 digits')
  .refine((pin) => !isWeakPin(pin), 'Pick a PIN that is harder to guess');
