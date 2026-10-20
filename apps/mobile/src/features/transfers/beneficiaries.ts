import type { Schema } from '@nem/contracts';

type Beneficiary = Schema<'Beneficiary'>;

export const NICKNAME_MAX_LENGTH = 40;

/**
 * New-beneficiary cooling-off (TRF-8): until the first payment, or until the window
 * ends, a large payment to someone just saved needs step-up or waits. Returns when
 * it ends, or null once the beneficiary is trusted.
 */
export function coolingOffUntil(b: Beneficiary, now: number = Date.now()): Date | null {
  if (b.last_paid_at || !b.cooling_off_until) return null;
  const until = new Date(b.cooling_off_until);
  return until.getTime() > now ? until : null;
}

/** "3:40 pm" today, "Tue 3:40 pm" later in the week. */
export function formatUntil(until: Date, now: number = Date.now()): string {
  const time = until.toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' });
  const sameDay = new Date(now).toDateString() === until.toDateString();
  return sameDay ? time : `${until.toLocaleDateString('en-NG', { weekday: 'short' })} ${time}`;
}

export function coolingOffMessage(until: Date, now: number = Date.now()): string {
  return `New: large payments need an extra check until ${formatUntil(until, now)}.`;
}

/** "Mummy (Ngozi Adebayo)" when nicknamed, else the account name. */
export const beneficiaryTitle = (b: Beneficiary) =>
  b.nickname ? `${b.nickname} (${b.name})` : b.name;

/** A nickname as the bank stores it: trimmed, and empty means none. */
export const cleanNickname = (value: string): string | null => value.trim() || null;
