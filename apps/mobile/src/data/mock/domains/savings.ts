import type { Schema } from '@nem/contracts';
import { add, divideRounded, money, negate, sum, zero, type Money } from '@nem/shared';

import { problem } from '../../errors';
import type { SavingsRepo } from '../../repositories';
import { addDays, api, fromApi, isoDate, newestFirst, notFound, positive } from '../convert';
import type { MockBank } from '../runtime';
import { customerTransactions } from '../views';
import type { GoalRecord, LockRecord } from '../world';

/** Locked savings rates by term (demo values, SAV-3). */
export const LOCK_RATES_BPS: Record<number, number> = {
  30: 1_000,
  60: 1_100,
  90: 1_400,
  180: 1_600,
  365: 1_800,
};
/** Breaking a lock early forfeits this share of the interest earned so far. */
export const EARLY_BREAK_PENALTY_BPS = 5_000;
const DAY = 86_400_000;

/** Simple interest for `days`, rounded down: the customer is never paid a fraction of a kobo. */
export function simpleInterest(principal: Money, rateBps: number, days: number): Money {
  return money(
    divideRounded(principal.amount * BigInt(rateBps) * BigInt(days), 3_650_000n, 'floor'),
    principal.currency,
  );
}

function move(
  bank: MockBank,
  input: {
    from: string;
    to: string;
    amount: Money;
    narration: string;
    key: string;
    direction: 'debit' | 'credit';
  },
) {
  const customerSide = input.direction === 'debit' ? input.from : input.to;
  return bank.ledger.post({
    kind: 'savings',
    reference: bank.reference('SAV'),
    idempotencyKey: input.key,
    postings: [
      { accountId: input.from, amount: negate(input.amount) },
      { accountId: input.to, amount: input.amount },
    ],
    metadata: {
      txns: [
        {
          id: bank.id(),
          accountId: customerSide,
          direction: input.direction,
          type: 'savings',
          category: 'savings',
          narration: input.narration,
          counterparty: { name: 'Nem Savings' },
        },
      ],
    },
  });
}

function payInterest(bank: MockBank, to: string, amount: Money, narration: string, key: string) {
  if (amount.amount <= 0n) return;
  bank.ledger.post({
    kind: 'interest_accrual',
    reference: bank.reference('INT'),
    idempotencyKey: key,
    postings: [
      {
        accountId: bank.ledger.systemAccount('interest_expense', amount.currency).id,
        amount: negate(amount),
      },
      { accountId: to, amount },
    ],
    metadata: {
      txns: [
        {
          id: bank.id(),
          accountId: to,
          direction: 'credit',
          type: 'interest',
          category: 'savings',
          narration,
          counterparty: { name: 'Nem Savings' },
        },
      ],
    },
  });
}

function goalView(bank: MockBank, goal: GoalRecord): Schema<'SavingsGoal'> {
  const { accountId, autoSaveNextAt: _next, ...rest } = goal;
  const balance = bank.ledger.account(accountId).balance;
  const target = fromApi(goal.target);
  const pct = target.amount > 0n ? Number((balance.amount * 100n) / target.amount) : 0;
  const status =
    goal.status === 'active' && balance.amount >= target.amount ? 'completed' : goal.status;
  return { ...rest, status, balance: api(balance), progress_pct: Math.min(pct, 100) };
}

function elapsedDays(bank: MockBank, lock: LockRecord) {
  return Math.max(
    0,
    Math.min(
      lock.term_days,
      Math.floor((bank.now().getTime() - Date.parse(lock.start_date)) / DAY),
    ),
  );
}

function lockView(bank: MockBank, lock: LockRecord): Schema<'LockedSaving'> {
  const { accountId: _accountId, ...rest } = lock;
  const accrued =
    lock.status === 'active'
      ? simpleInterest(fromApi(lock.principal), lock.rate_bps, elapsedDays(bank, lock))
      : zero('NGN');
  return { ...rest, accrued_interest: api(accrued) };
}

/** One auto-save period after `from`. */
function nextAutoSave(from: Date, frequency: Schema<'AutoSaveRule'>['frequency']): string {
  const next = new Date(from);
  if (frequency === 'monthly') next.setUTCMonth(next.getUTCMonth() + 1);
  else next.setUTCDate(next.getUTCDate() + (frequency === 'weekly' ? 7 : 1));
  return next.toISOString();
}

/** Auto-save (SAV-2): moves the rule's amount into each goal when due, until the target is met. */
export function processAutoSaves(bank: MockBank): boolean {
  const now = bank.now();
  let moved = false;
  for (const g of bank.world.goals) {
    if (g.status !== 'active' || !g.auto_save) continue;
    // Banks saved before auto-save ran start counting from now.
    if (!g.autoSaveNextAt) {
      g.autoSaveNextAt = nextAutoSave(now, g.auto_save.frequency);
      continue;
    }
    const rule = g.auto_save;
    // Time travel can skip many periods; catch up a bounded number of them.
    for (let i = 0; i < 400 && g.autoSaveNextAt <= now.toISOString(); i++) {
      const at = g.autoSaveNextAt;
      g.autoSaveNextAt = nextAutoSave(new Date(at), rule.frequency);
      const balance = bank.ledger.account(g.accountId).balance;
      if (balance.amount >= fromApi(g.target).amount) break;
      try {
        move(bank, {
          from: rule.source_account_id,
          to: g.accountId,
          amount: fromApi(rule.amount),
          narration: `Auto-save to ${g.name}`,
          key: `autosave:${g.id}:${at}`,
          direction: 'debit',
        });
        moved = true;
      } catch {
        bank.notify({
          category: 'savings',
          title: `Auto-save to ${g.name} skipped`,
          body: 'There was not enough in your naira account. We will try again next time.',
          deep_link: `nembank://grow/goals/${g.id}`,
        });
      }
    }
  }
  return moved;
}

export function processLocks(bank: MockBank): boolean {
  const today = isoDate(bank.now());
  const due = bank.world.locks.filter((l) => l.status === 'active' && l.maturity_date <= today);
  const ngn = bank.accountIn('NGN');
  if (!ngn) return false;
  for (const lock of due) {
    const principal = fromApi(lock.principal);
    const interest = fromApi(lock.expected_interest);
    move(bank, {
      from: lock.accountId,
      to: ngn.id,
      amount: principal,
      narration: 'Locked savings matured',
      key: `lock-mature:${lock.id}`,
      direction: 'credit',
    });
    payInterest(bank, ngn.id, interest, 'Locked savings interest', `lock-interest:${lock.id}`);
    lock.status = 'matured';
    lock.paid_out = api(add(principal, interest));
    bank.notify({
      category: 'savings',
      title: 'Your locked savings matured',
      body: 'Your money and interest are back in your naira account.',
      deep_link: `nembank://grow/locks/${lock.id}`,
    });
  }
  return due.length > 0;
}

export function savingsRepo(bank: MockBank): SavingsRepo {
  const goal = (id: string) => {
    const g = bank.world.goals.find((x) => x.id === id);
    if (!g) throw notFound('Goal');
    return g;
  };
  const lock = (id: string) => {
    const l = bank.world.locks.find((x) => x.id === id);
    if (!l) throw notFound('Locked saving');
    return l;
  };
  const quote = (amount: Money, termDays: number): Schema<'LockQuote'> => {
    const rate = LOCK_RATES_BPS[termDays];
    if (!rate) throw problem(422, 'validation_failed', 'Pick 30, 60, 90, 180 or 365 days');
    if (amount.amount < 1_000_000n)
      throw problem(422, 'validation_failed', 'Lock at least ₦10,000');
    return {
      amount: api(amount),
      term_days: termDays,
      rate_bps: rate,
      interest_at_maturity: api(simpleInterest(amount, rate, termDays)),
      maturity_date: isoDate(addDays(bank.now(), termDays)),
      early_break_penalty_bps: EARLY_BREAK_PENALTY_BPS,
      early_break_explanation:
        'You can break it any time, but you keep only half of the interest earned so far. Your full amount always comes back.',
    };
  };
  const activeGoal = (id: string) => {
    const g = goal(id);
    if (g.status === 'closed') throw problem(409, 'invalid_state', 'This goal is closed');
    return g;
  };

  return {
    async getSummary() {
      const goals = bank.world.goals.filter((g) => g.status !== 'closed');
      const locks = bank.world.locks.filter((l) => l.status === 'active');
      const saved = [
        ...goals.map((g) => bank.ledger.account(g.accountId).balance),
        ...locks.map((l) => fromApi(l.principal)),
      ];
      const month = bank.nowIso().slice(0, 7);
      const roundUps = customerTransactions(bank).filter(
        (t) =>
          t.type === 'savings' &&
          t.narration.startsWith('Round-up') &&
          t.created_at.startsWith(month),
      );
      return {
        total_saved: api(sum(saved, 'NGN')),
        interest_earned: api(
          sum(
            goals.map((g) => fromApi(g.interest_earned)),
            'NGN',
          ),
        ),
        goals_count: goals.length,
        locks_count: locks.length,
        round_ups_this_month: api(
          sum(
            roundUps.map((t) => fromApi(t.amount)),
            'NGN',
          ),
        ),
      };
    },
    async listGoals() {
      return { data: newestFirst(bank.world.goals).map((g) => goalView(bank, g)) };
    },
    async createGoal({ body, idempotencyKey }) {
      const created = bank.idempotent(
        idempotencyKey,
        body,
        (id) => bank.world.goals.find((g) => g.id === id),
        () => {
          const target = positive(body.target, 'NGN');
          if (body.auto_save) {
            bank.ownAccount(body.auto_save.source_account_id);
            positive(body.auto_save.amount, 'NGN');
          }
          const accountId = bank.ledger.openAccount({
            ownerType: 'customer',
            ownerId: bank.user.id,
            kind: 'customer_savings',
            currency: 'NGN',
          }).id;
          const g: GoalRecord = {
            id: bank.id(),
            accountId,
            name: body.name.trim(),
            emoji: body.emoji,
            target: api(target),
            target_date: body.target_date ?? null,
            auto_save: body.auto_save ?? null,
            autoSaveNextAt: body.auto_save
              ? nextAutoSave(bank.now(), body.auto_save.frequency)
              : null,
            interest_rate_bps: 1_000,
            interest_earned: api(zero('NGN')),
            status: 'active',
            created_at: bank.nowIso(),
          };
          bank.world.goals.push(g);
          return g;
        },
      );
      return goalView(bank, created);
    },
    async getGoal({ path }) {
      return goalView(bank, goal(path.goal_id));
    },
    async updateGoal({ path, body }) {
      const g = activeGoal(path.goal_id);
      if (body.name !== undefined) g.name = body.name.trim();
      if (body.emoji !== undefined) g.emoji = body.emoji;
      if (body.target !== undefined) g.target = api(positive(body.target, 'NGN'));
      if (body.target_date !== undefined) g.target_date = body.target_date;
      if (body.auto_save !== undefined) {
        if (body.auto_save) {
          bank.ownAccount(body.auto_save.source_account_id);
          positive(body.auto_save.amount, 'NGN');
        }
        g.auto_save = body.auto_save;
        g.autoSaveNextAt = body.auto_save
          ? nextAutoSave(bank.now(), body.auto_save.frequency)
          : null;
      }
      return goalView(bank, g);
    },
    async closeGoal({ path, idempotencyKey }) {
      const g = goal(path.goal_id);
      if (g.status === 'closed') return;
      const balance = bank.ledger.account(g.accountId).balance;
      const ngn = bank.accountIn('NGN')!;
      if (balance.amount > 0n) {
        move(bank, {
          from: g.accountId,
          to: ngn.id,
          amount: balance,
          narration: `Closed ${g.name}`,
          key: `close:${idempotencyKey}`,
          direction: 'credit',
        });
      }
      g.status = 'closed';
    },
    async deposit({ path, body, idempotencyKey }) {
      const g = activeGoal(path.goal_id);
      const source = bank.ownAccount(body.account_id);
      if (source.currency !== 'NGN')
        throw problem(422, 'validation_failed', 'Goals are saved in naira');
      move(bank, {
        from: source.id,
        to: g.accountId,
        amount: positive(body.amount, 'NGN'),
        narration: `Saved to ${g.name}`,
        key: idempotencyKey,
        direction: 'debit',
      });
      return goalView(bank, g);
    },
    async withdraw({ path, body, idempotencyKey }) {
      bank.assertCanSend();
      const g = activeGoal(path.goal_id);
      const to = bank.ownAccount(body.account_id);
      if (to.currency !== 'NGN')
        throw problem(422, 'validation_failed', 'Withdraw to your naira account');
      move(bank, {
        from: g.accountId,
        to: to.id,
        amount: positive(body.amount, 'NGN'),
        narration: `Withdrew from ${g.name}`,
        key: idempotencyKey,
        direction: 'credit',
      });
      return goalView(bank, g);
    },
    async getRoundUps() {
      return bank.world.roundUps;
    },
    async setRoundUps({ body }) {
      if (body.goal_id) activeGoal(body.goal_id);
      if (body.enabled && !body.goal_id)
        throw problem(422, 'validation_failed', 'Pick a goal for your round-ups');
      bank.world.roundUps = body;
      return body;
    },
    async quoteLock({ body }) {
      return quote(positive(body.amount, 'NGN'), body.term_days);
    },
    async listLocks() {
      return {
        data: [...bank.world.locks]
          .sort((a, b) => b.start_date.localeCompare(a.start_date))
          .map((l) => lockView(bank, l)),
      };
    },
    async createLock({ body, idempotencyKey }) {
      const created = bank.idempotent(
        idempotencyKey,
        body,
        (id) => bank.world.locks.find((l) => l.id === id),
        () => {
          if (!body.accepted_terms)
            throw problem(422, 'validation_failed', 'Accept the terms to lock your money');
          const source = bank.ownAccount(body.source_account_id);
          const terms = quote(positive(body.amount, 'NGN'), body.term_days);
          const accountId = bank.ledger.openAccount({
            ownerType: 'customer',
            ownerId: bank.user.id,
            kind: 'customer_locked',
            currency: 'NGN',
          }).id;
          move(bank, {
            from: source.id,
            to: accountId,
            amount: fromApi(terms.amount),
            narration: `Locked savings (${body.term_days} days)`,
            key: `lock:${idempotencyKey}`,
            direction: 'debit',
          });
          const l: LockRecord = {
            id: bank.id(),
            accountId,
            principal: terms.amount,
            term_days: body.term_days,
            rate_bps: terms.rate_bps,
            start_date: isoDate(bank.now()),
            maturity_date: terms.maturity_date,
            expected_interest: terms.interest_at_maturity,
            early_break_penalty_bps: EARLY_BREAK_PENALTY_BPS,
            status: 'active',
            paid_out: null,
          };
          bank.world.locks.push(l);
          return l;
        },
      );
      return lockView(bank, created);
    },
    async getLock({ path }) {
      return lockView(bank, lock(path.lock_id));
    },
    async breakLock({ path, idempotencyKey }) {
      const l = lock(path.lock_id);
      if (l.status !== 'active') {
        if (l.paid_out) return lockView(bank, l);
        throw problem(409, 'invalid_state', 'This lock has ended');
      }
      const ngn = bank.accountIn('NGN')!;
      const principal = fromApi(l.principal);
      const accrued = simpleInterest(principal, l.rate_bps, elapsedDays(bank, l));
      // The penalty is taken from interest only, rounded in the customer's favour.
      const kept = money(
        divideRounded(accrued.amount * BigInt(10_000 - l.early_break_penalty_bps), 10_000n, 'ceil'),
        'NGN',
      );
      move(bank, {
        from: l.accountId,
        to: ngn.id,
        amount: principal,
        narration: 'Broke locked savings',
        key: `break:${idempotencyKey}`,
        direction: 'credit',
      });
      payInterest(
        bank,
        ngn.id,
        kept,
        'Locked savings interest (early)',
        `break-interest:${idempotencyKey}`,
      );
      l.status = 'broken';
      l.paid_out = api(add(principal, kept));
      return lockView(bank, l);
    },
  };
}
