import type { Schema } from '@nem/contracts';
import { money, type Money } from '@nem/shared';

type Lock = Schema<'LockedSaving'>;

/** The terms a lock can run for (SAV-4), with the demo bank's yearly rates. */
export const LOCK_TERMS = [30, 60, 90, 180, 365] as const;
export const MIN_LOCK_NAIRA = 10_000;

/** 1400 → "14%". */
export const ratePct = (bps: number) => `${bps / 100}%`;

/** 365 → "1 year", 90 → "90 days". */
export const termLabel = (days: number) => (days === 365 ? '1 year' : `${days} days`);

/** What breaking now keeps: the penalty comes out of interest only, rounded in the customer's favour. */
export function keptOnBreak(lock: Lock, accrued: Money): Money {
  const keep = BigInt(10_000 - lock.early_break_penalty_bps);
  return money((accrued.amount * keep + 9_999n) / 10_000n, accrued.currency);
}

/** Days from the start to today, out of the whole term, for the progress bar. */
export function lockProgress(lock: Lock, today: Date = new Date()): number {
  const start = Date.parse(`${lock.start_date}T00:00:00Z`);
  const days = Math.floor((today.getTime() - start) / 86_400_000);
  return Math.max(0, Math.min(1, days / lock.term_days));
}

/** Active locks first (soonest to mature), then the ones that ended. */
export function sortLocks(locks: readonly Lock[]): Lock[] {
  const active = locks.filter((l) => l.status === 'active');
  const ended = locks.filter((l) => l.status !== 'active');
  return [...active.sort((a, b) => a.maturity_date.localeCompare(b.maturity_date)), ...ended];
}

export const LOCK_STATUS: Record<Lock['status'], string> = {
  active: 'Locked',
  matured: 'Matured',
  broken: 'Broken early',
};
