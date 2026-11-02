import { money, type CurrencyCode, type Money } from '@nem/shared';

import type { LatencyProfile } from '@/data/mock/simulation';
import { withLabel } from '@/lib/i18n';

// Demo Controls offers fixed choices rather than free entry: one tap sets up a
// scenario, and every amount is one a Nigerian user would recognise.

/** Amounts per wallet, in minor units. */
const AMOUNTS: Record<CurrencyCode, readonly bigint[]> = {
  NGN: [500_000n, 5_000_000n, 50_000_000n],
  USD: [5_000n, 50_000n, 200_000n],
  GBP: [5_000n, 50_000n, 200_000n],
  EUR: [5_000n, 50_000n, 200_000n],
};

export const amountsFor = (currency: CurrencyCode): Money[] =>
  AMOUNTS[currency].map((minor) => money(minor, currency));

/** Who an incoming transfer is from: another Nigerian bank for naira, a payout abroad for FX. */
export const SENDERS: Record<CurrencyCode, { name: string; bank: string; narration: string }> = {
  NGN: { name: 'Chidinma Okafor', bank: 'Guaranty Trust Bank', narration: 'For the weekend' },
  USD: { name: 'Upwork Global Inc', bank: 'Citibank N.A.', narration: 'Freelance payout' },
  GBP: { name: 'Adaeze Nwosu', bank: 'Monzo Bank', narration: 'Birthday gift' },
  EUR: { name: 'Kwame Mensah', bank: 'N26', narration: 'Shared rent' },
};

export const TIME_TRAVEL_DAYS = [1, 7, 30] as const;

export const LATENCIES = (
  ['off', 'fast', 'realistic', 'slow'] as const satisfies LatencyProfile[]
).map((value) => withLabel(`demo.network.latency.${value}`, { value }));

export const ERROR_RATES: { readonly value: number; readonly label: string }[] = [
  withLabel('demo.network.none', { value: 0 }),
  { value: 0.1, label: '10%' },
  { value: 0.3, label: '30%' },
  withLabel('demo.network.all', { value: 1 }),
];
