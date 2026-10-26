import type { Schema } from '@nem/contracts';
import { money, sum, type Money } from '@nem/shared';

import { fromApiMoney } from '@/lib/money';

/**
 * Simple interest for `days` at a yearly rate, rounded down, the way the bank
 * pays it (SAV-5): a projection never promises a kobo more than is paid.
 */
export function projectInterest(balance: Money, rateBps: number, days: number): Money {
  return money((balance.amount * BigInt(rateBps) * BigInt(days)) / 3_650_000n, balance.currency);
}

/** What the open goals would earn together over `days`, at today's balances. */
export function projectGoalsInterest(goals: readonly Schema<'SavingsGoal'>[], days: number): Money {
  return sum(
    goals
      .filter((g) => g.status !== 'closed')
      .map((g) => projectInterest(fromApiMoney(g.balance), g.interest_rate_bps, days)),
    'NGN',
  );
}
