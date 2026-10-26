import type { Schema } from '@nem/contracts';

import { CATEGORIES } from '@/features/transactions/categories';

type CategorySpend = Schema<'CategorySpend'>;

const monthName = new Intl.DateTimeFormat('en-NG', { month: 'long', timeZone: 'UTC' });
const monthYear = new Intl.DateTimeFormat('en-NG', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "2026-10" → "October". */
export const monthLabel = (month: string) => monthName.format(new Date(`${month}-01T00:00:00Z`));

/** "2026-10" → "October 2026". */
export const monthYearLabel = (month: string) =>
  monthYear.format(new Date(`${month}-01T00:00:00Z`));

/** "2026-01" shifted by -1 → "2025-12". */
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const index = y * 12 + (m - 1) + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** How far back the month picker goes: the mock bank keeps six months of history. */
export const MONTHS_BACK = 5;

/** The donut stays readable with a handful of slices; the rest share one. */
export const MAX_SLICES = 5;

export type Slice = { label: string; minor: bigint };

/** Biggest categories first (the API sorts them), the tail folded into "Everything else". */
export function donutSlices(categories: readonly CategorySpend[]): Slice[] {
  const slices = categories.map((c) => ({
    label: (CATEGORIES[c.category] ?? CATEGORIES.other).label,
    minor: BigInt(c.amount.amount_minor),
  }));
  if (slices.length <= MAX_SLICES) return slices;
  const head = slices.slice(0, MAX_SLICES - 1);
  const rest = slices.slice(MAX_SLICES - 1).reduce((sum, s) => sum + s.minor, 0n);
  return [...head, { label: 'Everything else', minor: rest }];
}

/** `new`: nothing on this category the month before. */
export type Change = { kind: 'new' } | { kind: 'same' } | { kind: 'more' | 'less'; minor: bigint };

/**
 * This month against last. A month still in progress only counts as "more"
 * once it has already passed last month's total: anything below that would
 * read as saving when the month simply is not over yet.
 */
export function changeOf(nowMinor: bigint, beforeMinor: bigint, inProgress: boolean): Change {
  if (beforeMinor === 0n) return nowMinor === 0n ? { kind: 'same' } : { kind: 'new' };
  if (nowMinor === beforeMinor) return { kind: 'same' };
  if (nowMinor > beforeMinor) return { kind: 'more', minor: nowMinor - beforeMinor };
  return inProgress ? { kind: 'same' } : { kind: 'less', minor: beforeMinor - nowMinor };
}
