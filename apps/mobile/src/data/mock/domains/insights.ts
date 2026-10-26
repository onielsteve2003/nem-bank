import type { Schema } from '@nem/contracts';
import { formatMoney, money, sum, zero, type CurrencyCode, type Money } from '@nem/shared';

import { problem } from '../../errors';
import type { InsightsRepo } from '../../repositories';
import { addDays, api, fromApi, isoDate, notFound, positive } from '../convert';
import { sha256Hex } from '../documents';
import type { MockBank } from '../runtime';
import { customerTransactions } from '../views';

type Transaction = Schema<'Transaction'>;

/** Money moved between the customer's own pots is not spending. */
const NOT_SPENDING: ReadonlySet<Schema<'TransactionType'>> = new Set([
  'fx_conversion',
  'savings',
  'ajo',
  'loan_repayment',
  'reversal',
]);

const monthOf = (iso: string) => iso.slice(0, 7);

function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

function spending(bank: MockBank, month: string, currency: CurrencyCode): Transaction[] {
  return customerTransactions(bank).filter(
    (t) =>
      t.direction === 'debit' &&
      t.status === 'completed' &&
      t.amount.currency === currency &&
      !NOT_SPENDING.has(t.type) &&
      monthOf(t.created_at) === month,
  );
}

const total = (txns: Transaction[], currency: CurrencyCode) =>
  sum(
    txns.map((t) => fromApi(t.amount)),
    currency,
  );

/** Whole-number shares that always add up to 100 (largest remainder method). */
export function sharesOf(amounts: readonly bigint[]): number[] {
  const all = amounts.reduce((a, b) => a + b, 0n);
  if (all === 0n) return amounts.map(() => 0);
  const exact = amounts.map((a) => Number((a * 1_000_000n) / all) / 10_000);
  const floors = exact.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => [e - floors[i]!, i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    floors[i]! += 1;
    left -= 1;
  }
  return floors;
}

function breakdown(
  bank: MockBank,
  month: string,
  currency: CurrencyCode,
): Schema<'SpendingBreakdown'> {
  const now = spending(bank, month, currency);
  const before = spending(bank, previousMonth(month), currency);
  const byCategory = new Map<Schema<'Category'>, Money>();
  for (const t of now) {
    byCategory.set(
      t.category,
      money((byCategory.get(t.category)?.amount ?? 0n) + BigInt(t.amount.amount_minor), currency),
    );
  }
  const rows = [...byCategory.entries()].sort((a, b) => (b[1].amount > a[1].amount ? 1 : -1));
  const shares = sharesOf(rows.map(([, m]) => m.amount));
  return {
    month,
    total: api(total(now, currency)),
    previous_total: api(total(before, currency)),
    categories: rows.map(([category, amount], i) => ({
      category,
      amount: api(amount),
      share_pct: shares[i]!,
      previous_amount: api(
        total(
          before.filter((t) => t.category === category),
          currency,
        ),
      ),
    })),
  };
}

/** Same merchant, similar amount, in at least three different months: a subscription. */
function detectSubscriptions(bank: MockBank): Schema<'DetectedSubscription'>[] {
  const byMerchant = new Map<string, Transaction[]>();
  for (const t of customerTransactions(bank)) {
    if (t.direction !== 'debit' || (t.type !== 'card_payment' && t.type !== 'bill_payment'))
      continue;
    if (
      t.category !== 'subscriptions' &&
      t.category !== 'bills_utilities' &&
      t.category !== 'airtime_data'
    )
      continue;
    const list = byMerchant.get(t.counterparty.name) ?? [];
    list.push(t);
    byMerchant.set(t.counterparty.name, list);
  }
  const found: Schema<'DetectedSubscription'>[] = [];
  for (const [merchant, txns] of byMerchant) {
    const months = new Set(txns.map((t) => monthOf(t.created_at)));
    const amounts = new Set(txns.map((t) => t.amount.amount_minor));
    if (months.size < 3 || amounts.size > 2 || txns.length > months.size + 1) continue;
    const latest = txns[0]!;
    const hash = sha256Hex(`subscription:${merchant}`);
    found.push({
      id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-7${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
      merchant,
      amount: latest.amount,
      frequency: 'monthly',
      last_charged_at: latest.created_at,
      next_expected_at: isoDate(addDays(new Date(latest.created_at), 30)),
      card_id: latest.card_id ?? null,
    });
  }
  return found.sort((a, b) => a.next_expected_at.localeCompare(b.next_expected_at));
}

function nextPayday(from: Date): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 25));
  if (d.getTime() <= from.getTime()) d.setUTCMonth(d.getUTCMonth() + 1);
  return isoDate(d);
}

type BudgetRecord = MockBank['world']['budgets'][number];

/** This month's spend on a budget's category, and the whole percent of the limit it is. */
function budgetUse(bank: MockBank, b: BudgetRecord) {
  const month = monthOf(bank.nowIso());
  const spent = total(
    spending(bank, month, 'NGN').filter((t) => t.category === b.category),
    'NGN',
  );
  const limit = fromApi(b.limit);
  const pct = limit.amount > 0n ? Number((spent.amount * 100n) / limit.amount) : 0;
  const level: 0 | 80 | 100 = pct >= 100 ? 100 : pct >= 80 ? 80 : 0;
  return { month, spent, limit, pct, level };
}

/** "rent_housing" → "rent & housing": two-word categories are all "x & y". */
const categoryName = (c: Schema<'Category'>) => c.replaceAll('_', ' & ');

/**
 * Budget alerts (INS-2): one notification when this month's spending on a
 * category reaches 80% of its budget and one when it reaches 100%. A month
 * that jumps straight past 100% gets only the 100% alert.
 */
export function processBudgetAlerts(bank: MockBank): boolean {
  let changed = false;
  for (const b of bank.world.budgets) {
    const { month, spent, limit, pct, level } = budgetUse(bank, b);
    const sent = b.alerted?.month === month ? b.alerted.level : 0;
    if (level === 0 || level <= sent) continue;
    const name = categoryName(b.category);
    bank.notify({
      category: 'transactions',
      title:
        level === 100
          ? `You’ve reached your ${name} budget`
          : `You’ve used ${pct}% of your ${name} budget`,
      body:
        level === 100
          ? `${formatMoney(spent)} spent this month against ${formatMoney(limit)}.`
          : `${formatMoney(spent)} of ${formatMoney(limit)} spent this month.`,
      deep_link: 'nembank://grow/insights/budgets',
    });
    b.alerted = { month, level };
    changed = true;
  }
  return changed;
}

export function insightsRepo(bank: MockBank): InsightsRepo {
  const budget = (id: string) => {
    const b = bank.world.budgets.find((x) => x.id === id);
    if (!b) throw notFound('Budget');
    return b;
  };
  const budgetView = ({ alerted: _, ...b }: BudgetRecord): Schema<'Budget'> => {
    const { spent, level } = budgetUse(bank, b);
    return {
      ...b,
      spent: api(spent),
      status: level === 100 ? 'exceeded' : level === 80 ? 'warning' : 'ok',
    };
  };
  /** A new or changed limit starts from where spending is now: no alert for what is already known. */
  const settle = (b: BudgetRecord) => {
    const { month, level } = budgetUse(bank, b);
    b.alerted = level ? { month, level } : undefined;
  };

  return {
    async getSpending({ query } = {}) {
      return breakdown(bank, query?.month ?? monthOf(bank.nowIso()), query?.currency ?? 'NGN');
    },
    async listBudgets() {
      return { data: bank.world.budgets.map(budgetView) };
    },
    async createBudget({ body }) {
      if (bank.world.budgets.some((b) => b.category === body.category)) {
        throw problem(409, 'budget_exists', 'You already have a budget for this category');
      }
      const b = {
        id: bank.id(),
        category: body.category,
        limit: api(positive(body.limit, 'NGN')),
        alert_at_pct: [80, 100] as (80 | 100)[],
      };
      settle(b);
      bank.world.budgets.push(b);
      return budgetView(b);
    },
    async updateBudget({ path, body }) {
      const b = budget(path.budget_id);
      b.limit = api(positive(body.limit, 'NGN'));
      settle(b);
      return budgetView(b);
    },
    async deleteBudget({ path }) {
      budget(path.budget_id);
      bank.world.budgets = bank.world.budgets.filter((b) => b.id !== path.budget_id);
    },
    async getForecast() {
      const now = bank.now();
      const ngn = bank.accountIn('NGN');
      const balance = ngn ? bank.ledger.available(ngn.id) : zero('NGN');
      const last90 = customerTransactions(bank).filter(
        (t) =>
          t.amount.currency === 'NGN' &&
          t.status === 'completed' &&
          t.created_at >= addDays(now, -90).toISOString(),
      );
      const spend = last90.filter((t) => t.direction === 'debit' && !NOT_SPENDING.has(t.type));
      const daily = total(spend, 'NGN').amount / 90n;
      const salary = last90
        .filter((t) => t.category === 'salary_income')
        .map((t) => BigInt(t.amount.amount_minor));
      const salaryAmount = salary.length
        ? salary.reduce((a, b) => a + b, 0n) / BigInt(salary.length)
        : 0n;
      const payday = salary.length ? nextPayday(now) : null;
      const points: Schema<'ForecastPoint'>[] = [];
      let running = balance.amount;
      for (let day = 1; day <= 30; day++) {
        const date = isoDate(addDays(now, day));
        running -= daily;
        if (payday && date === payday) running += salaryAmount;
        // The band widens with distance: ±1.5% of a day's spend per day ahead.
        const band = (daily * BigInt(day) * 15n) / 100n;
        points.push({
          date,
          balance: api(money(running, 'NGN')),
          low: api(money(running - band, 'NGN')),
          high: api(money(running + band, 'NGN')),
        });
      }
      const subscriptions = detectSubscriptions(bank).filter((s) => s.amount.currency === 'NGN');
      const upcoming = [
        ...subscriptions.map((s) => ({
          label: s.merchant,
          amount: s.amount,
          date: s.next_expected_at,
          direction: 'debit' as const,
        })),
        ...(payday
          ? [
              {
                label: 'Salary',
                amount: api(money(salaryAmount, 'NGN')),
                date: payday,
                direction: 'credit' as const,
              },
            ]
          : []),
      ]
        .filter((u) => u.date <= points.at(-1)!.date)
        .sort((a, b) => a.date.localeCompare(b.date));
      return {
        next_payday: payday,
        projected_balance: points.at(-1)!.balance,
        points,
        explanation: `You spend about ${formatMoney(money(daily, 'NGN'))} a day.${payday ? ` Salary is expected on ${payday}.` : ''}`,
        upcoming,
        ai: {
          feature: 'forecast',
          model_version: 'rules-mock-1',
          explanation:
            'Projects your average daily spending forward and adds expected salary and subscriptions.',
          fallback_used: true,
        },
      };
    },
    async listSubscriptions() {
      const data = detectSubscriptions(bank);
      return {
        data,
        monthly_total: api(
          sum(
            data.filter((s) => s.amount.currency === 'NGN').map((s) => fromApi(s.amount)),
            'NGN',
          ),
        ),
        ai: {
          feature: 'smart_categories',
          model_version: 'rules-mock-1',
          explanation: 'Merchants that charged you a similar amount in three or more months.',
          fallback_used: true,
        },
      };
    },
    async getMoneyStory({ query } = {}) {
      const month = query?.month ?? previousMonth(monthOf(bank.nowIso()));
      const b = breakdown(bank, month, 'NGN');
      const txns = spending(bank, month, 'NGN');
      const byDay = new Map<string, bigint>();
      for (const t of txns)
        byDay.set(
          t.created_at.slice(0, 10),
          (byDay.get(t.created_at.slice(0, 10)) ?? 0n) + BigInt(t.amount.amount_minor),
        );
      const biggest = [...byDay.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1))[0];
      const top = b.categories[0];
      const saved = customerTransactions(bank).filter(
        (t) => t.type === 'savings' && t.direction === 'debit' && monthOf(t.created_at) === month,
      );
      const totalNow = fromApi(b.total);
      const totalBefore = fromApi(b.previous_total);
      const label = new Date(`${month}-01T12:00:00Z`).toLocaleString('en-NG', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      });
      const slides: Schema<'StorySlide'>[] = [
        { kind: 'intro', title: `Your ${label}`, body: 'Here is how your money moved this month.' },
        {
          kind: 'total_spent',
          title: 'You spent',
          body: `${txns.length} payments in all.`,
          amount: b.total,
        },
      ];
      if (top)
        slides.push({
          kind: 'top_category',
          title: 'Top category',
          body: `${top.share_pct}% of your spending.`,
          amount: top.amount,
          category: top.category,
        });
      if (biggest)
        slides.push({
          kind: 'biggest_day',
          title: 'Biggest day',
          body: `${biggest[0]} was your biggest spending day.`,
          amount: api(money(biggest[1], 'NGN')),
        });
      slides.push({
        kind: 'saved',
        title: 'You saved',
        body: saved.length ? 'Every bit counts.' : 'Start a goal to see this grow.',
        amount: api(total(saved, 'NGN')),
      });
      const diff = totalNow.amount - totalBefore.amount;
      slides.push({
        kind: 'compared',
        title: diff > 0n ? 'A bit more than last month' : 'Less than last month',
        body: `${formatMoney(money(diff < 0n ? -diff : diff, 'NGN'))} ${diff > 0n ? 'more' : 'less'} than the month before.`,
        amount: b.previous_total,
      });
      slides.push({
        kind: 'tip',
        title: 'Tip',
        body: top
          ? `Set a budget for ${top.category.replaceAll('_', ' ')} to keep it in check.`
          : 'Set a budget to stay on track.',
      });
      slides.push({
        kind: 'outro',
        title: 'That was your month',
        body: 'Share it, or keep it to yourself. Your call.',
      });
      return { month, slides, share_image_url: null };
    },
  };
}
