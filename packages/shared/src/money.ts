import { z } from 'zod';

import { CURRENCIES, currencyCodeSchema, type CurrencyCode } from './currency';

/**
 * An amount of money in integer minor units (kobo, cents, pence).
 * Floats never touch money: arithmetic is bigint, and JSON carries the amount as a string.
 */
export interface Money {
  readonly amount: bigint;
  readonly currency: CurrencyCode;
}

/** Wire shape: `{ "amount": "150000", "currency": "NGN" }` is ₦1,500.00. */
export const moneyDtoSchema = z.object({
  amount: z.string().regex(/^-?\d+$/, 'Amount must be an integer number of minor units'),
  currency: currencyCodeSchema,
});

export type MoneyDto = z.infer<typeof moneyDtoSchema>;

export class CurrencyMismatchError extends Error {
  constructor(a: CurrencyCode, b: CurrencyCode) {
    super(`Cannot combine ${a} with ${b} without an FX conversion`);
    this.name = 'CurrencyMismatchError';
  }
}

export type Rounding = 'half-up' | 'floor' | 'ceil';

export function money(amount: bigint | string | number, currency: CurrencyCode): Money {
  if (typeof amount === 'number' && !Number.isSafeInteger(amount)) {
    throw new RangeError(`Minor units must be a safe integer, got ${amount}`);
  }
  return { amount: BigInt(amount), currency };
}

export const zero = (currency: CurrencyCode): Money => money(0n, currency);

export function toDto(m: Money): MoneyDto {
  return { amount: m.amount.toString(), currency: m.currency };
}

export function fromDto(dto: unknown): Money {
  const parsed = moneyDtoSchema.parse(dto);
  return money(parsed.amount, parsed.currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount - b.amount, a.currency);
}

export function negate(m: Money): Money {
  return money(-m.amount, m.currency);
}

export function sum(items: readonly Money[], currency: CurrencyCode): Money {
  return items.reduce(add, zero(currency));
}

/** -1, 0 or 1, like a sort comparator. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  return a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0;
}

export const equals = (a: Money, b: Money): boolean => compare(a, b) === 0;
export const isZero = (m: Money): boolean => m.amount === 0n;
export const isNegative = (m: Money): boolean => m.amount < 0n;
export const isPositive = (m: Money): boolean => m.amount > 0n;

/** Integer division with an explicit rounding rule (bigint division truncates toward zero). */
export function divideRounded(numerator: bigint, denominator: bigint, rounding: Rounding): bigint {
  if (denominator === 0n) throw new RangeError('Division by zero');
  if (denominator < 0n) return divideRounded(-numerator, -denominator, rounding);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  const negative = numerator < 0n;
  switch (rounding) {
    case 'floor':
      return negative ? quotient - 1n : quotient;
    case 'ceil':
      return negative ? quotient : quotient + 1n;
    case 'half-up': {
      // Half away from zero: 2.5 -> 3, -2.5 -> -3.
      const twice = (negative ? -remainder : remainder) * 2n;
      if (twice < denominator) return quotient;
      return negative ? quotient - 1n : quotient + 1n;
    }
  }
}

/** A percentage of `m` in basis points (1 bp = 0.01%), e.g. a 1.5% spread is 150 bp. */
export function percentOf(m: Money, basisPoints: bigint, rounding: Rounding): Money {
  return money(divideRounded(m.amount * basisPoints, 10_000n, rounding), m.currency);
}

/**
 * Parses a user-typed major-unit string ("1,500.5", "₦20000") into minor units.
 * Rejects more decimals than the currency allows rather than rounding silently.
 */
export function parseMajor(input: string, currency: CurrencyCode): Money {
  const { minorDigits, symbol } = CURRENCIES[currency];
  const cleaned = input.trim().replaceAll(symbol, '').replaceAll(',', '').replaceAll(' ', '');
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(cleaned);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) {
    throw new SyntaxError(`"${input}" is not a valid ${currency} amount`);
  }
  const [, sign = '', whole = '', fraction = ''] = match;
  if (fraction.length > minorDigits) {
    throw new RangeError(`${currency} allows at most ${minorDigits} decimal places`);
  }
  const minor = BigInt((whole || '0') + fraction.padEnd(minorDigits, '0'));
  return money(sign === '-' ? -minor : minor, currency);
}
