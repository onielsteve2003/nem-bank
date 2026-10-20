import type { Schema } from '@nem/contracts';
import type { CurrencyCode } from '@nem/shared';

type Transaction = Schema<'Transaction'>;
type TransactionType = Schema<'TransactionType'>;
export type TransactionStatus = Schema<'TransactionStatus'>;

/** Types grouped the way people think about them; the API filters on the raw list. */
export const TYPE_GROUPS = {
  transfers: { label: 'Transfers', types: ['transfer_in', 'transfer_out', 'deposit'] },
  card: { label: 'Card', types: ['card_payment', 'card_refund'] },
  bills: { label: 'Bills', types: ['bill_payment'] },
  fx: { label: 'Conversions', types: ['fx_conversion'] },
  saving: { label: 'Savings & ajo', types: ['savings', 'ajo'] },
  loans: { label: 'Loans', types: ['loan_disbursement', 'loan_repayment'] },
  charges: { label: 'Fees & interest', types: ['interest', 'fee', 'levy'] },
  refunds: { label: 'Reversals', types: ['reversal', 'dispute_refund'] },
} as const satisfies Record<string, { label: string; types: readonly TransactionType[] }>;
export type TypeGroup = keyof typeof TYPE_GROUPS;

export const STATUS_LABELS: Record<TransactionStatus, string> = {
  pending: 'Pending',
  completed: 'Completed',
  failed: 'Failed',
  reversed: 'Reversed',
};

export const DATE_RANGES = {
  d7: 'Last 7 days',
  d30: 'Last 30 days',
  d90: 'Last 90 days',
  month: 'This month',
} as const;
export type DateRange = keyof typeof DATE_RANGES;

export interface TransactionFilters {
  types: readonly TypeGroup[];
  currency: CurrencyCode | null;
  status: TransactionStatus | null;
  range: DateRange | null;
  search: string;
}

export const NO_FILTERS: TransactionFilters = {
  types: [],
  currency: null,
  status: null,
  range: null,
  search: '',
};

export const PAGE_SIZE = 30;

const DAY_MS = 86_400_000;
/** The Lagos calendar date (UTC+1) of an instant, as YYYY-MM-DD. */
export const lagosDate = (at: Date) =>
  new Date(at.getTime() + 3_600_000).toISOString().slice(0, 10);

/** Filters → the list call's query (no cursor). Dates are Lagos days, inclusive. */
export function toQuery(f: TransactionFilters, now: Date = new Date()) {
  const today = lagosDate(now);
  const back = (days: number) => lagosDate(new Date(now.getTime() - (days - 1) * DAY_MS));
  const from =
    f.range === 'month'
      ? `${today.slice(0, 8)}01`
      : f.range
        ? back(Number(f.range.slice(1)))
        : undefined;
  const q = f.search.trim();
  return {
    limit: PAGE_SIZE,
    ...(f.types.length > 0 && { type: f.types.flatMap((g) => TYPE_GROUPS[g].types) }),
    ...(f.currency && { currency: f.currency }),
    ...(f.status && { status: f.status }),
    ...(from && { from, to: today }),
    ...(q && { q: q.slice(0, 100) }),
  };
}

/** How many filters are on (search excluded: it has its own field). */
export const activeFilterCount = (f: TransactionFilters) =>
  (f.types.length > 0 ? 1 : 0) + [f.currency, f.status, f.range].filter(Boolean).length;

export type ListRow =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'txn'; key: string; transaction: Transaction };

const dayLabel = new Intl.DateTimeFormat('en-NG', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

/** "Today", "Yesterday", else "Mon, 12 Oct" (with the year once it isn't this one). */
export function formatDay(date: string, now: Date = new Date()): string {
  const today = lagosDate(now);
  if (date === today) return 'Today';
  if (date === lagosDate(new Date(now.getTime() - DAY_MS))) return 'Yesterday';
  const label = dayLabel.format(new Date(`${date}T00:00:00Z`));
  return date.slice(0, 4) === today.slice(0, 4) ? label : `${label} ${date.slice(0, 4)}`;
}

/** Newest-first transactions → rows with a header before each Lagos day. */
export function groupByDay(items: readonly Transaction[], now: Date = new Date()): ListRow[] {
  const rows: ListRow[] = [];
  let current = '';
  for (const t of items) {
    const day = lagosDate(new Date(t.created_at));
    if (day !== current) {
      current = day;
      rows.push({ kind: 'day', key: `day-${day}`, label: formatDay(day, now) });
    }
    rows.push({ kind: 'txn', key: t.id, transaction: t });
  }
  return rows;
}
