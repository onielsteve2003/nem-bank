import type { Schema } from '@nem/contracts';
import {
  compare,
  convertAtRate,
  CURRENCIES,
  formatMoney,
  formatRate,
  FX_QUOTE_TTL_SECONDS,
  isNegative,
  isPositive,
  money,
  parseMajor,
  parseRate,
  subtract,
  zero,
  type CurrencyCode,
  type Money,
} from '@nem/shared';

import { isApiError } from '@/data';
import { fromApiMoney } from '@/lib/money';

type Account = Schema<'Account'>;
type Quote = Schema<'FxQuote'>;

/**
 * The wallets `from` can convert into. Every conversion goes through naira
 * (FX-1): naira converts to any foreign wallet, a foreign wallet back to naira.
 */
export function convertibleInto(accounts: readonly Account[], from: Account): Account[] {
  return accounts.filter((a) =>
    from.currency === 'NGN' ? a.currency !== 'NGN' : a.currency === 'NGN',
  );
}

/** The typed major-unit amount in `currency`, or null while nothing is typed. */
export function typedAmount(typed: string, currency: CurrencyCode): Money | null {
  if (typed === '' || typed === '.') return null;
  const amount = parseMajor(typed, currency);
  return isPositive(amount) ? amount : null;
}

const invert = (rate: string) => {
  const { numerator, denominator } = parseRate(rate);
  return formatRate({ numerator: denominator, denominator: numerator }, 'half-up');
};

/**
 * What one unit of the foreign currency costs in naira at `rate` (units of `to`
 * per unit of `from`), the way Nigerians read a rate: "$1 = ₦1,609.77" either way
 * round. Rounded half-up for display only; the quote's amounts are what move.
 */
export function nairaPerUnit(rate: string, from: CurrencyCode, to: CurrencyCode): Money {
  const foreign = from === 'NGN' ? to : from;
  const one = money(10n ** BigInt(CURRENCIES[foreign].minorDigits), foreign);
  return convertAtRate(one, from === 'NGN' ? invert(rate) : rate, 'NGN', 'half-up');
}

/** "$1 = ₦1,609.77" for a quote's customer or mid rate. */
export function rateLine(rate: string, from: CurrencyCode, to: CurrencyCode): string {
  const foreign = from === 'NGN' ? to : from;
  return `${CURRENCIES[foreign].symbol}1 = ${formatMoney(nairaPerUnit(rate, from, to))}`;
}

/**
 * What the spread costs the customer, in the currency they receive: what the
 * same sale would buy at the mid-market rate, less what the quote gives. Shown
 * so the price of a conversion is never hidden inside the rate.
 */
export function spreadCost(quote: Quote): Money {
  const buy = fromApiMoney(quote.buy);
  const atMid = convertAtRate(fromApiMoney(quote.sell), quote.mid_rate, buy.currency, 'floor');
  const cost = subtract(atMid, buy);
  return isNegative(cost) ? zero(buy.currency) : cost;
}

/** "1.5%" from basis points. */
export const spreadPercent = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

/**
 * When a quote received at `receivedAt` (local clock) stops being honoured. The
 * bank holds a rate for 60 seconds from when it made it; counting from when the
 * answer arrived keeps the countdown honest even if the phone clock is off, and
 * the bank refuses an expired quote anyway.
 */
export const quoteDeadline = (receivedAt: number) =>
  new Date(receivedAt + FX_QUOTE_TTL_SECONDS * 1000).toISOString();

/** Why this amount cannot be converted, or null if it can. */
export function convertProblem(sell: Money, available: Money): string | null {
  return compare(sell, available) > 0
    ? `More than your available ${formatMoney(available)}.`
    : null;
}

/**
 * Why converting failed, in the customer's words, and whether the rate needs
 * pricing again first. A lost answer keeps the idempotency key, so "try again"
 * can never convert twice.
 */
export function convertErrorMessage(error: Error): { message: string; requote: boolean } {
  if (!isApiError(error)) {
    return {
      message: "We couldn't convert it. Nothing has left your wallet. Try again.",
      requote: false,
    };
  }
  const { code, title, detail } = error.problem;
  switch (code) {
    case 'quote_expired':
      return { message: 'That rate expired. Check the new rate and confirm again.', requote: true };
    case 'insufficient_funds':
    case 'max_balance_exceeded':
    case 'validation_failed':
      return { message: detail ?? title, requote: true };
    case 'offline':
      return {
        message: "You're offline. Reconnect and try again; it won't convert twice.",
        requote: false,
      };
    case 'gateway_timeout':
    case 'service_unavailable':
    case 'network_error':
      return {
        message:
          "We didn't hear back. Try again: if it already went through, it won't convert twice.",
        requote: false,
      };
    default:
      return { message: detail ?? "We couldn't convert it. Try again.", requote: false };
  }
}
