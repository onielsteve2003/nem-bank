import { CURRENCIES, type CurrencyCode } from './currency';
import { divideRounded, money, type Money, type Rounding } from './money';

/**
 * An exchange rate as an exact fraction: `numerator / denominator` units of the
 * quote currency per one unit of the base currency. Parsed from the contract's
 * decimal `Rate` string, so no float ever touches a conversion.
 */
export interface ExactRate {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/** The contract allows up to 8 decimal places. */
export const RATE_DECIMALS = 8;

const RATE_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,8}))?$/;

export function parseRate(rate: string): ExactRate {
  const match = RATE_PATTERN.exec(rate);
  if (!match) throw new SyntaxError(`"${rate}" is not a valid rate`);
  const [, whole = '0', fraction = ''] = match;
  const value = {
    numerator: BigInt(whole + fraction),
    denominator: 10n ** BigInt(fraction.length),
  };
  if (value.numerator === 0n) throw new RangeError('A rate must be greater than zero');
  return value;
}

/** Formats an exact rate as a decimal string, rounded to 8 places. */
export function formatRate(rate: ExactRate, rounding: Rounding): string {
  const scale = 10n ** BigInt(RATE_DECIMALS);
  const scaled = divideRounded(rate.numerator * scale, rate.denominator, rounding);
  const digits = scaled.toString().padStart(RATE_DECIMALS + 1, '0');
  const whole = digits.slice(0, -RATE_DECIMALS);
  const fraction = digits.slice(-RATE_DECIMALS).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * The customer rate after the bank's spread: `mid × (1 − spread)`, rounded to 8
 * places. Floor, because a spread is a margin and the rate the customer sees is
 * the rate they get.
 */
export function applySpread(midRate: string, spreadBps: number): string {
  if (!Number.isInteger(spreadBps) || spreadBps < 0 || spreadBps >= 10_000) {
    throw new RangeError('Spread must be whole basis points between 0 and 9999');
  }
  const mid = parseRate(midRate);
  return formatRate(
    {
      numerator: mid.numerator * BigInt(10_000 - spreadBps),
      denominator: mid.denominator * 10_000n,
    },
    'floor',
  );
}

/**
 * Converts `amount` into `to` at `rate` (units of `to` per one unit of `amount`'s
 * currency). Major units are what the rate prices, so minor digits are rescaled.
 * The caller names the rounding: conversions the customer buys round down.
 */
export function convertAtRate(
  amount: Money,
  rate: string,
  to: CurrencyCode,
  rounding: Rounding,
): Money {
  const { numerator, denominator } = parseRate(rate);
  const digitShift = CURRENCIES[to].minorDigits - CURRENCIES[amount.currency].minorDigits;
  const scaleUp = digitShift > 0 ? 10n ** BigInt(digitShift) : 1n;
  const scaleDown = digitShift < 0 ? 10n ** BigInt(-digitShift) : 1n;
  return money(
    divideRounded(amount.amount * numerator * scaleUp, denominator * scaleDown, rounding),
    to,
  );
}
