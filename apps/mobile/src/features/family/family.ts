import type { Schema } from '@nem/contracts';
import { formatMoney, money, type Money } from '@nem/shared';

import { fromApiMoney, toApiMoney } from '@/lib/money';

/** Children on Nem are 6 to 17; at 18 they open their own account. */
export const DEPENDANT_MIN_AGE = 6;
export const DEPENDANT_MAX_AGE = 17;

/** Whole years old on `now`, from an ISO date of birth. */
export function ageOn(dateOfBirth: string, now: Date): number {
  const [y, m, d] = dateOfBirth.split('-').map(Number) as [number, number, number];
  let years = now.getUTCFullYear() - y;
  const month = now.getUTCMonth() + 1;
  if (month < m || (month === m && now.getUTCDate() < d)) years -= 1;
  return years;
}

/** Why a child's date of birth can't be used, or undefined. */
export function dependantAgeProblem(dateOfBirth: string, now: Date): string | undefined {
  const age = ageOn(dateOfBirth, now);
  if (age < 0) return 'That date is in the future';
  if (age < DEPENDANT_MIN_AGE) return `Children need to be at least ${DEPENDANT_MIN_AGE}`;
  if (age > DEPENDANT_MAX_AGE) return 'At 18 they can open their own Nem account';
  return undefined;
}

const naira = (major: number): Money => money(BigInt(major) * 100n, 'NGN');

/** Daily spend limits a parent picks from, in naira. */
export const DAILY_LIMIT_PRESETS = [2_000, 5_000, 10_000, 20_000].map(naira);
/** Above this, a child's transfer waits for the parent (FAM-2). */
export const APPROVAL_PRESETS = [1_000, 2_000, 5_000, 10_000].map(naira);

export type Controls = Schema<'DependantControls'>;

/** Where a new child starts: modest limits, Nem users only, nothing paused. */
export const DEFAULT_CONTROLS: Controls = {
  daily_spend_limit: toApiMoney(DAILY_LIMIT_PRESETS[1]!),
  approval_threshold: toApiMoney(APPROVAL_PRESETS[1]!),
  can_send_to_banks: false,
  paused: false,
};

export const nairaText = (m: Schema<'Money'>) =>
  formatMoney(fromApiMoney(m), { trimZeroMinor: true });

/** A child's controls in one line each, the way a parent reads them. */
export function controlsSummary(c: Controls): string[] {
  return [
    `Spends up to ${nairaText(c.daily_spend_limit)} a day`,
    `Asks you before sending more than ${nairaText(c.approval_threshold)}`,
    c.can_send_to_banks ? 'Can send to other banks' : 'Can pay Nem users only',
  ];
}

/** The one-time setup code in two groups of four, easier to read aloud. */
export const formatSetupCode = (code: string) => code.replace(/^(\d{4})(\d{4})$/, '$1 $2');
