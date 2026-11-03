import type { CurrencyCode, Schema, TransferStatus } from '@nem/contracts';

import { problem } from '../errors';
import { daysBetween, lagosDate, shiftDate } from '@/lib/dates';

import type { Handlers } from './handlers';

// Deterministic KPIs for any period: the same dates always give the same numbers, and
// a longer period gives proportionally more activity, so the date filter behaves.

const MAX_DAYS = 366;

/** Small seeded PRNG so every figure varies a little by period, not by reload. */
function seeded(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

// Per-day base activity in minor units: NGN dominates, diaspora corridors trail.
const DAILY_VOLUME: Readonly<Record<CurrencyCode, { in: bigint; out: bigint; count: number }>> = {
  NGN: { in: 48_500_000_00n, out: 46_200_000_00n, count: 3_900 },
  USD: { in: 21_400_00n, out: 18_900_00n, count: 140 },
  GBP: { in: 9_800_00n, out: 8_100_00n, count: 61 },
  EUR: { in: 6_300_00n, out: 5_700_00n, count: 38 },
};
const DAILY_FX_PNL: Readonly<Record<CurrencyCode, bigint>> = {
  NGN: 1_850_000_00n,
  USD: 410_00n,
  GBP: 160_00n,
  EUR: 95_00n,
};
// Share of transfers per status, in basis points of the day's count.
const STATUS_MIX: readonly [TransferStatus, number][] = [
  ['completed', 9_420],
  ['processing', 180],
  ['failed', 140],
  ['reversed', 35],
  ['held_for_review', 62],
  ['pending_step_up', 48],
  ['delayed', 40],
  ['rejected', 21],
  ['cancelled', 54],
];

const money = (amount: bigint, currency: CurrencyCode) => ({
  amount_minor: amount.toString(),
  currency,
});

/** Integer jitter of ±spread around 1, applied in basis points to stay in bigint. */
const jitter = (rand: () => number, spread = 0.12) =>
  BigInt(Math.round((1 + (rand() * 2 - 1) * spread) * 10_000));

export function buildDashboard(from: string, to: string): Schema<'AdminDashboard'> {
  const days = daysBetween(from, to);
  const rand = seeded(`${from}:${to}`);
  const span = BigInt(days);

  const currencies = Object.keys(DAILY_VOLUME) as CurrencyCode[];
  const volume = currencies.map((currency) => {
    const base = DAILY_VOLUME[currency];
    return {
      currency,
      inflow: money((base.in * span * jitter(rand)) / 10_000n, currency),
      outflow: money((base.out * span * jitter(rand)) / 10_000n, currency),
      count: Math.round(base.count * days * (0.9 + rand() * 0.2)),
    };
  });
  const transfers = volume.reduce((n, v) => n + v.count, 0);
  const transfersByStatus = STATUS_MIX.map(([status, bps]) => ({
    status,
    count: Math.round((transfers * bps * (0.85 + rand() * 0.3)) / 10_000),
  }));
  const held = transfersByStatus.find((s) => s.status === 'held_for_review')?.count ?? 0;

  return {
    period_from: from,
    period_to: to,
    users_total: 184_230,
    users_new: Math.round(days * (210 + rand() * 60)),
    users_active_30d: 96_480,
    volume,
    transfers_by_status: transfersByStatus,
    // Rounded down: a rate is never overstated by rounding.
    fraud_hold_rate_bps: transfers === 0 ? 0 : Math.floor((held * 10_000) / transfers),
    fx_pnl: currencies.map((c) => money((DAILY_FX_PNL[c] * span * jitter(rand)) / 10_000n, c)),
    queues: {
      kyc_pending: 14,
      fraud_open: 6,
      disputes_open: 9,
      support_open: 11,
      approvals_pending: 3,
    },
  };
}

export const dashboardHandlers: Handlers = {
  getAdminDashboard: ({ query } = {}, { state }) => {
    const to = query?.to ?? lagosDate(state.now());
    const from = query?.from ?? shiftDate(to, -29);
    const days = daysBetween(from, to);
    if (days < 1 || days > MAX_DAYS) {
      throw problem(422, 'validation_failed', 'Pick a period of 1 to 366 days', {
        errors: [
          { field: '/from', code: 'out_of_range', message: 'From must be on or before To.' },
        ],
      });
    }
    return buildDashboard(from, to);
  },
};
