import type { Schema } from '@nem/contracts';
import { formatLockoutWait } from '@nem/shared';
import i18n from '@/lib/i18n';

/** The words under the PIN pad after a wrong PIN or a lockout (AUTH-4). */
export function pinErrorMessage(
  result: Schema<'PinVerification'>,
  now: number = Date.now(),
): string {
  if (result.locked_until) {
    const wait = formatLockoutWait((Date.parse(result.locked_until) - now) / 60_000);
    return i18n.t('lock.lockedOut', { wait });
  }
  return i18n.t('lock.wrong', { count: result.attempts_remaining });
}
