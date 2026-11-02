import type { Schema } from '@nem/contracts';
import { formatMoney, money, type Money } from '@nem/shared';

import i18n, { withLabel } from '@/lib/i18n';
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
  if (age < 0) return i18n.t('family.age.future');
  if (age < DEPENDANT_MIN_AGE) return i18n.t('family.age.young', { min: DEPENDANT_MIN_AGE });
  if (age > DEPENDANT_MAX_AGE) return i18n.t('family.age.old');
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
    i18n.t('family.controls.daily', { amount: nairaText(c.daily_spend_limit) }),
    i18n.t('family.controls.approval', { amount: nairaText(c.approval_threshold) }),
    i18n.t(c.can_send_to_banks ? 'family.controls.banks' : 'family.controls.nemOnly'),
  ];
}

/** The one-time setup code in two groups of four, easier to read aloud. */
export const formatSetupCode = (code: string) => code.replace(/^(\d{4})(\d{4})$/, '$1 $2');

/** Allowance amounts a parent picks from, in naira. */
export const ALLOWANCE_PRESETS = [1_000, 2_000, 5_000, 10_000].map(naira);

/** Monday = 1 … Sunday = 7, the way the contract numbers weekdays. */
export const weekdays = (): readonly string[] => i18n.t('family.weekdays', { returnObjects: true });
/** Days of the month an allowance can land on; 28 so every month has it. */
export const MONTH_DAYS = [1, 7, 14, 21, 28];

const ordinal = (n: number) => {
  const rule = new Intl.PluralRules('en', { type: 'ordinal' }).select(n);
  return `${n}${{ one: 'st', two: 'nd', few: 'rd' }[rule as 'one'] ?? 'th'}`;
};

/** "₦2,000 every Friday" or "₦5,000 on the 1st of each month". */
export function allowanceSummary(a: Schema<'Allowance'>): string {
  const amount = nairaText(a.amount);
  return a.frequency === 'weekly'
    ? i18n.t('family.allowanceWeekly', { amount, day: weekdays()[(a.day ?? 5) - 1] })
    : i18n.t('family.allowanceMonthly', { amount, day: ordinal(a.day ?? 1) });
}

export const APPROVAL_STATUS: Record<
  Schema<'ApprovalStatus'>,
  { label: string; tone: 'warning' | 'success' | 'danger' | 'neutral' }
> = {
  pending: withLabel('family.approvalStatus.pending', { tone: 'warning' }),
  approved: withLabel('family.approvalStatus.approved', { tone: 'success' }),
  declined: withLabel('family.approvalStatus.declined', { tone: 'danger' }),
  expired: withLabel('family.approvalStatus.expired', { tone: 'neutral' }),
};

/** Goal targets a child picks from, in naira. */
export const KID_GOAL_PRESETS = [2_000, 5_000, 10_000, 25_000].map(naira);
export const KID_GOAL_EMOJIS = ['🎮', '⚽', '📚', '🚲', '🎧', '🧸', '🎨', '🎁'];

const sameUtcDay = (a: Date, b: Date) =>
  a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);

/** What a child has left to spend today under their daily limit, never below zero. */
export function spendLeftToday(
  controls: Controls,
  transactions: Schema<'Transaction'>[],
  now: Date,
): Money {
  const limit = fromApiMoney(controls.daily_spend_limit).amount;
  const spent = transactions
    .filter((t) => t.direction === 'debit' && sameUtcDay(new Date(t.created_at), now))
    .reduce((sum, t) => sum + fromApiMoney(t.amount).amount, 0n);
  return money(limit > spent ? limit - spent : 0n, 'NGN');
}

/** How far a balance gets towards a goal, 0 to 100. */
export function goalPercent(balanceMinor: bigint, targetMinor: bigint): number {
  if (targetMinor <= 0n) return 100;
  const pct = Number((balanceMinor * 100n) / targetMinor);
  return Math.max(0, Math.min(100, pct));
}
