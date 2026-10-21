import type { Schema } from '@nem/contracts';
import { formatMoney, parseRate, type CurrencyCode } from '@nem/shared';

import { nairaPerUnit } from './quote';

type Range = Schema<'FxRateHistory'>['range'];
type Alert = Schema<'FxAlert'>;
type Direction = Alert['direction'];

export type ForeignCurrency = Exclude<CurrencyCode, 'NGN'>;

export const PAIRS: readonly { pair: string; currency: ForeignCurrency }[] = [
  { pair: 'USD-NGN', currency: 'USD' },
  { pair: 'GBP-NGN', currency: 'GBP' },
  { pair: 'EUR-NGN', currency: 'EUR' },
];

export const RANGES: readonly { range: Range; label: string; spoken: string }[] = [
  { range: '1D', label: '1D', spoken: 'last day' },
  { range: '1W', label: '1W', spoken: 'last week' },
  { range: '1M', label: '1M', spoken: 'last month' },
  { range: '1Y', label: '1Y', spoken: 'last year' },
];

/** "USD-NGN" → "USD/NGN" */
export const pairLabel = (pair: string) => pair.replace('-', '/');

const foreignOf = (pair: string) => pair.split('-')[0] as ForeignCurrency;

/** A pair's rate as Nigerians read it: "₦1,609.77" for one unit of the foreign currency. */
export const nairaRate = (pair: string, rate: string) =>
  formatMoney(nairaPerUnit(rate, foreignOf(pair), 'NGN'));

const TIME = new Intl.DateTimeFormat('en-NG', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Africa/Lagos',
});
const DAY = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'short',
  timeZone: 'Africa/Lagos',
});
const MONTH = new Intl.DateTimeFormat('en-NG', {
  month: 'short',
  year: '2-digit',
  timeZone: 'Africa/Lagos',
});

/** Axis label for a point: the time for a day, the date for a week or month, the month for a year. */
export function pointLabel(at: string, range: Range): string {
  const date = new Date(at);
  if (range === '1D') return TIME.format(date);
  if (range === '1Y') return MONTH.format(date);
  return DAY.format(date);
}

/**
 * Chart points. A rate is plotted, never paid, so a float is fine here: money
 * on screen still comes from the exact rate strings.
 */
export const chartData = (history: Schema<'FxRateHistory'>) =>
  history.points.map((p) => ({ label: pointLabel(p.at, history.range), value: Number(p.rate) }));

/** How the rate moved across the range, for the headline: "+1.24%" and which way. */
export function rateChange(points: readonly { rate: string }[]) {
  const first = Number(points[0]?.rate);
  const last = Number(points.at(-1)?.rate);
  if (!first || !last) return null;
  const percent = ((last - first) / first) * 100;
  const rounded = Math.round(percent * 100) / 100;
  const direction = rounded > 0 ? 'up' : rounded < 0 ? 'down' : 'flat';
  const sign = rounded > 0 ? '+' : '';
  return { direction, label: `${sign}${rounded.toFixed(2)}%` } as const;
}

/** Exact comparison of two decimal rate strings. */
export function compareRates(a: string, b: string): -1 | 0 | 1 {
  const x = parseRate(a);
  const y = parseRate(b);
  const left = x.numerator * y.denominator;
  const right = y.numerator * x.denominator;
  return left === right ? 0 : left > right ? 1 : -1;
}

const TARGET_PATTERN = /^\d{1,7}(\.\d{1,2})?$/;

/**
 * Why a typed alert target cannot be saved, or null if it can. An alert that
 * would fire the moment it is made is refused: it tells the customer nothing.
 */
export function alertTargetProblem(
  typed: string,
  direction: Direction,
  pair: string,
  midRate: string | undefined,
): string | null {
  const target = typed.trim();
  if (!TARGET_PATTERN.test(target) || Number(target) <= 0) {
    return 'Enter a rate in naira, like 1650 or 1650.50.';
  }
  if (!midRate) return null;
  const vs = compareRates(target, midRate);
  if (direction === 'above' && vs <= 0) {
    return `${pairLabel(pair)} is already at ${nairaRate(pair, midRate)}. Pick a higher rate.`;
  }
  if (direction === 'below' && vs >= 0) {
    return `${pairLabel(pair)} is already at ${nairaRate(pair, midRate)}. Pick a lower rate.`;
  }
  return null;
}

/** "USD/NGN above ₦1,650.00" */
export const alertTitle = (alert: Pick<Alert, 'pair' | 'direction' | 'target_rate'>) =>
  `${pairLabel(alert.pair)} ${alert.direction} ${nairaRate(alert.pair, alert.target_rate)}`;
