import type { Schema } from '@nem/contracts';

type Point = Schema<'ForecastPoint'>;

const dayMonth = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const weekdayDayMonth = new Intl.DateTimeFormat('en-NG', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

/** "2026-11-03" → "3 Nov". */
export const shortDate = (date: string) => dayMonth.format(new Date(`${date}T00:00:00Z`));

/** "2026-11-03" → "Tue, 3 Nov". */
export const longDate = (date: string) => weekdayDayMonth.format(new Date(`${date}T00:00:00Z`));

/** The first day the projected balance drops below zero, if it does. */
export const firstShortfall = (points: readonly Point[]) =>
  points.find((p) => BigInt(p.balance.amount_minor) < 0n);

/**
 * The balance to plan around: the day before salary lands when payday is in
 * the window (that is the tightest day), otherwise the last day forecast.
 */
export function horizon(points: readonly Point[], payday: string | null): Point | undefined {
  const at = payday ? points.findIndex((p) => p.date === payday) : -1;
  return at > 0 ? points[at - 1] : points.at(-1);
}
