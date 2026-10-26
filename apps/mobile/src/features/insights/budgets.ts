import type { Schema } from '@nem/contracts';
import { CircleAlert, CircleCheck, OctagonAlert, type LucideIcon } from 'lucide-react-native';

import type { Tone } from '@/components';
import { CATEGORIES, type Category } from '@/features/transactions/categories';

type Budget = Schema<'Budget'>;

export const BUDGET_STATUS: Record<
  Budget['status'],
  { label: string; tone: Tone; icon: LucideIcon; color: 'success' | 'warning' | 'danger' }
> = {
  ok: { label: 'On track', tone: 'success', icon: CircleCheck, color: 'success' },
  warning: { label: 'Nearly there', tone: 'warning', icon: CircleAlert, color: 'warning' },
  exceeded: { label: 'Over budget', tone: 'danger', icon: OctagonAlert, color: 'danger' },
};

/** Income and money moved to the customer's own savings are never spending. */
const NOT_SPENDING: ReadonlySet<Category> = new Set(['salary_income', 'savings']);

/** Categories a new budget can cover: spending ones without a budget yet. */
export function budgetableCategories(budgets: readonly Budget[]): Category[] {
  const taken = new Set(budgets.map((b) => b.category));
  return (Object.keys(CATEGORIES) as Category[]).filter(
    (c) => !NOT_SPENDING.has(c) && !taken.has(c),
  );
}

/** Whole percent of the limit spent, rounded down so 79.9% never reads as 80%. */
export function usedPct(budget: Budget): number {
  const limit = BigInt(budget.limit.amount_minor);
  if (limit === 0n) return 0;
  return Number((BigInt(budget.spent.amount_minor) * 100n) / limit);
}

/** Over budget first, then nearly there, then the rest by how much is used. */
export function sortBudgets(budgets: readonly Budget[]): Budget[] {
  const order: Record<Budget['status'], number> = { exceeded: 0, warning: 1, ok: 2 };
  return [...budgets].sort((a, b) => order[a.status] - order[b.status] || usedPct(b) - usedPct(a));
}
