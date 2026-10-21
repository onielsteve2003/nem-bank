import type { Schema } from '@nem/contracts';
import { compare, formatMoney, isPositive, parseMajor, type Money } from '@nem/shared';

import { fromApiMoney } from '@/lib/money';

type Quote = Schema<'TransferQuote'>;

export const NARRATION_MAX_LENGTH = 100;

/** The typed major-unit amount as naira Money, or null while nothing is typed. */
export function typedNaira(typed: string): Money | null {
  if (typed === '' || typed === '.') return null;
  const amount = parseMajor(typed, 'NGN');
  return isPositive(amount) ? amount : null;
}

/** Kobo as AmountInput types it: 250050n → "2500.5", 500000n → "5000". */
export function typedFromKobo(kobo: bigint): string {
  const whole = kobo / 100n;
  const rest = kobo % 100n;
  if (rest === 0n) return whole.toString();
  return `${whole}.${rest.toString().padStart(2, '0').replace(/0$/, '')}`;
}

export interface AmountChecks {
  amount: Money;
  /** What the source wallet can spend now. */
  available: Money;
  /** The customer's own per-transfer limit (SEC-3), if they set one. */
  singleLimit: Money | null;
  /** The bank's price for exactly this amount, once it has answered. */
  quote: Quote | null;
}

/**
 * Why this amount cannot be sent, in the customer's words, or null if it can.
 * Checked in the order the customer can do something about: their own limit,
 * the day's remaining limit (raise it by upgrading KYC), then the balance
 * including the fee. The bank checks all of it again when the transfer is made.
 */
export function amountProblem({
  amount,
  available,
  singleLimit,
  quote,
}: AmountChecks): string | null {
  if (singleLimit && compare(amount, singleLimit) > 0) {
    return `Above your own limit of ${formatMoney(singleLimit)} per transfer.`;
  }
  if (compare(amount, available) > 0) {
    return `More than your available ${formatMoney(available)}.`;
  }
  if (!quote) return null;
  const remaining = fromApiMoney(quote.limits.remaining_today);
  if (compare(amount, remaining) > 0) {
    return isPositive(remaining)
      ? `You can send ${formatMoney(remaining)} more today on Tier ${quote.limits.kyc_tier}.`
      : `You have reached today's limit on Tier ${quote.limits.kyc_tier}.`;
  }
  const total = fromApiMoney(quote.total_debit);
  if (compare(total, available) > 0) {
    return `You need ${formatMoney(total)} including the ${formatMoney(fromApiMoney(quote.fee))} fee.`;
  }
  return null;
}

/** The cooling-off line to show before confirming (TRF-8), if any applies. */
export function coolingOffNotice(quote: Quote): string | null {
  const c = quote.cooling_off;
  if (!c) return null;
  if (c.reason === 'new_device') {
    return "You signed in on this phone recently, so we'll ask you to confirm it's you.";
  }
  return `First large payment to a new beneficiary: it goes out in ${c.delay_minutes} minutes${
    c.step_up_skips_delay ? ', or straight away if you confirm it is you' : ''
  }.`;
}
