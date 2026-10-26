import type { Schema } from '@nem/contracts';
import { formatMoney, money } from '@nem/shared';

import type { Repositories } from '@/data';
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

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "₦1,234.56 interest earned · 1 lock matured · 2 ajo payouts made". */
export function describeTravel(before: Snapshot, after: Snapshot): string {
  const interest = after.interest - before.interest;
  const matured = after.matured - before.matured;
  const turns = after.turns - before.turns;
  const parts = [
    interest > 0n ? `${formatMoney(money(interest, 'NGN'))} interest earned` : null,
    matured > 0 ? `${plural(matured, 'lock', 'locks')} matured` : null,
    turns > 0 ? `${plural(turns, 'ajo payout', 'ajo payouts')} made` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'No savings or ajo activity was due.';
}
