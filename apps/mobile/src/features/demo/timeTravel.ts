import type { Schema } from '@nem/contracts';
import { formatMoney, money } from '@nem/shared';

import type { Repositories } from '@/data';
import i18n from '@/lib/i18n';
import { fromApiMoney } from '@/lib/money';

/** The savings and ajo numbers a jump in time moves, read before and after it. */
export type Snapshot = { interest: bigint; matured: number; turns: number };

const turnsDone = (g: Schema<'AjoGroup'>) =>
  g.status === 'completed' ? g.total_cycles : g.status === 'active' ? g.current_cycle - 1 : 0;

export async function snapshot(repos: Repositories): Promise<Snapshot> {
  const [summary, locks, groups] = await Promise.all([
    repos.savings.getSummary(),
    repos.savings.listLocks(),
    repos.ajo.listGroups(),
  ]);
  return {
    interest:
      fromApiMoney(summary.interest_earned).amount +
      locks.data
        .filter((l) => l.status === 'matured')
        .reduce((total, l) => total + fromApiMoney(l.expected_interest).amount, 0n),
    matured: locks.data.filter((l) => l.status === 'matured').length,
    turns: groups.data.reduce((total, g) => total + turnsDone(g), 0),
  };
}

/** "₦1,234.56 interest earned · 1 lock matured · 2 ajo payouts made". */
export function describeTravel(before: Snapshot, after: Snapshot): string {
  const interest = after.interest - before.interest;
  const matured = after.matured - before.matured;
  const turns = after.turns - before.turns;
  const parts = [
    interest > 0n
      ? i18n.t('demo.travel.interest', { amount: formatMoney(money(interest, 'NGN')) })
      : null,
    matured > 0 ? i18n.t('demo.travel.locks', { count: matured }) : null,
    turns > 0 ? i18n.t('demo.travel.payouts', { count: turns }) : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : i18n.t('demo.travel.nothing');
}
