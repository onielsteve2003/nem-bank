import type { Schema } from '@nem/contracts';
import { isPositive, subtract, sum, zero, type Money } from '@nem/shared';

import { fromApiMoney } from '@/lib/money';
import { localized } from '@/lib/i18n';

type Hold = Schema<'Hold'>;

export const HOLD_REASONS = localized<Schema<'HoldReason'>>({
  card_authorization: 'accounts.holdReasons.card_authorization',
  pending_transfer: 'accounts.holdReasons.pending_transfer',
  delayed_transfer: 'accounts.holdReasons.delayed_transfer',
  fraud_review: 'accounts.holdReasons.fraud_review',
  ajo_contribution: 'accounts.holdReasons.ajo_contribution',
  dispute: 'accounts.holdReasons.dispute',
});

export interface BalanceBreakdown {
  ledger: Money;
  available: Money;
  /** ledger − available: everything reserved but not yet gone. */
  onHold: Money;
  /** Reserved money the hold list does not account for (a hold that just settled, say). */
  unlisted: Money;
}

/**
 * Ledger balance is every posted entry; available is what can be spent now.
 * The difference is money reserved by holds (ACC-3). The bank's own figures
 * are the truth: the hold list only explains them, so any gap is shown rather
 * than recalculated away.
 */
export function balanceBreakdown(
  account: Schema<'Account'>,
  holds: readonly Hold[],
): BalanceBreakdown {
  const ledger = fromApiMoney(account.ledger_balance);
  const available = fromApiMoney(account.available_balance);
  const onHold = subtract(ledger, available);
  const listed = sum(
    holds.map((h) => fromApiMoney(h.amount)),
    account.currency,
  );
  const gap = subtract(onHold, listed);
  return { ledger, available, onHold, unlisted: isPositive(gap) ? gap : zero(account.currency) };
}
