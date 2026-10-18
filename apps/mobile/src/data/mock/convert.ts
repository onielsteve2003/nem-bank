import type { Schema } from '@nem/contracts';
import { money, type CurrencyCode, type Money } from '@nem/shared';

import { problem } from '../errors';

// The ledger works in bigint Money; the contract carries minor units as strings.
// These are the only two crossings between them.

export type ApiMoney = Schema<'Money'>;

export const api = (m: Money): ApiMoney => ({
  amount_minor: m.amount.toString(),
  currency: m.currency,
});

export function fromApi(dto: ApiMoney): Money {
  if (!/^-?\d+$/.test(dto.amount_minor)) {
    throw problem(400, 'validation_failed', 'Amounts must be whole minor units');
  }
  return money(dto.amount_minor, dto.currency);
}

/** A positive amount in the expected currency, or a 422 the form can show. */
export function positive(dto: ApiMoney, currency?: CurrencyCode): Money {
  const m = fromApi(dto);
  if (m.amount <= 0n) throw problem(422, 'validation_failed', 'Enter an amount above zero');
  if (currency && m.currency !== currency) {
    throw problem(422, 'currency_mismatch', `Amount must be in ${currency}`);
  }
  return m;
}

export const naira = (major: number): Money => money(BigInt(major) * 100n, 'NGN');

export const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Opaque cursor pagination over an already-sorted list. The cursor is an offset
 * here; the server's is a keyset, but callers only ever pass it back.
 */
export function paginate<T>(
  items: readonly T[],
  query: { cursor?: string; limit?: number } = {},
): { data: T[]; page: Schema<'PageInfo'> } {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = query.cursor ? Number.parseInt(query.cursor.replace(/^o/, ''), 36) : 0;
  if (!Number.isFinite(offset) || offset < 0) {
    throw problem(400, 'validation_failed', 'The page cursor is not valid');
  }
  const data = items.slice(offset, offset + limit);
  const next = offset + limit;
  return { data, page: { next_cursor: next < items.length ? `o${next.toString(36)}` : null } };
}

export function notFound(what: string) {
  return problem(404, 'not_found', `${what} not found`);
}

export const maskAccount = (accountNumber: string) => `******${accountNumber.slice(-4)}`;

export function maskEmail(email: string): string {
  const [name = '', domain = ''] = email.split('@');
  return `${name.slice(0, 1)}${'*'.repeat(Math.max(name.length - 2, 1))}${name.slice(-1)}@${domain}`;
}

/** Newest first, the order every list endpoint returns. */
export const newestFirst = <T extends { created_at: string }>(items: readonly T[]) =>
  [...items].sort((a, b) => b.created_at.localeCompare(a.created_at));

export const addMinutes = (date: Date, minutes: number) =>
  new Date(date.getTime() + minutes * 60_000);
export const addDays = (date: Date, days: number) => addMinutes(date, days * 24 * 60);
export const isoDate = (date: Date) => date.toISOString().slice(0, 10);
