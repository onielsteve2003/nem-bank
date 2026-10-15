import { CURRENCIES } from './currency';
import type { Money } from './money';

export interface FormatMoneyOptions {
  /** Prefix the currency symbol (default true). */
  symbol?: boolean;
  /** Drop ".00" when the amount is whole (default false). */
  trimZeroMinor?: boolean;
  /** Show "+" for positive amounts, for credits in transaction lists (default false). */
  signPositive?: boolean;
}

const groupThousands = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * Formats money as "₦1,234.56" or "-$0.05". Built on bigint string maths, not Intl,
 * so it is exact for any size and identical on Hermes, web and Node.
 */
export function formatMoney(m: Money, options: FormatMoneyOptions = {}): string {
  const { symbol = true, trimZeroMinor = false, signPositive = false } = options;
  const { minorDigits, symbol: currencySymbol } = CURRENCIES[m.currency];

  const negative = m.amount < 0n;
  const digits = (negative ? -m.amount : m.amount).toString().padStart(minorDigits + 1, '0');
  const whole = groupThousands(digits.slice(0, digits.length - minorDigits));
  const fraction = minorDigits > 0 ? digits.slice(-minorDigits) : '';
  const showFraction = fraction !== '' && !(trimZeroMinor && /^0+$/.test(fraction));

  const sign = negative ? '-' : signPositive && m.amount > 0n ? '+' : '';
  return `${sign}${symbol ? currencySymbol : ''}${whole}${showFraction ? `.${fraction}` : ''}`;
}

/** Major units without grouping, for prefilling an amount input: 150050n kobo -> "1500.50". */
export function toMajorString(m: Money): string {
  return formatMoney(m, { symbol: false }).replaceAll(',', '');
}
