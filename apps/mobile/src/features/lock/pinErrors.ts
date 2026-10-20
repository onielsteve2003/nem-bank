import type { Schema } from '@nem/contracts';
import { formatLockoutWait } from '@nem/shared';

/** The words under the PIN pad after a wrong PIN or a lockout (AUTH-4). */
export function pinErrorMessage(
  result: Schema<'PinVerification'>,
  now: number = Date.now(),
): string {
  if (result.locked_until) {
    const wait = formatLockoutWait((Date.parse(result.locked_until) - now) / 60_000);
    return `Too many wrong tries. Try again in ${wait}, or tap Forgot PIN.`;
  }
  const left = result.attempts_remaining;
  return `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.`;
}
