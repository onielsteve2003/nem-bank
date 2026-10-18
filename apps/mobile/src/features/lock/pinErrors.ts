import type { Schema } from '@nem/contracts';

/** The words under the PIN pad after a wrong PIN or a lockout (AUTH-4). */
export function pinErrorMessage(
  result: Schema<'PinVerification'>,
  now: number = Date.now(),
): string {
  if (result.locked_until) {
    const minutes = Math.max(1, Math.ceil((Date.parse(result.locked_until) - now) / 60_000));
    return `Too many wrong tries. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}, or sign out.`;
  }
  const left = result.attempts_remaining;
  return `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.`;
}
