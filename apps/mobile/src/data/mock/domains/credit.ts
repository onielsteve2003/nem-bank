import type { Schema } from '@nem/contracts';
import { divideRounded, money, negate, percentOf, zero, type Money } from '@nem/shared';

import { isApiError, problem } from '../../errors';
import type { CreditRepo } from '../../repositories';
import { addDays, addMinutes, api, fromApi, isoDate, naira, notFound, positive } from '../convert';
import type { MockBank } from '../runtime';
import { customerTransactions } from '../views';
import type { LoanRecord } from '../world';
import { simpleInterest } from './savings';

// Salary-backed micro-loans (CRD-1..4). The loan is a receivable ledger account:
// disbursement books principal + interest + fees on it, so the outstanding amount
// is always the negated balance and every repayment is one posting.

const APR_BPS: Record<30 | 60 | 90 | 180, number> = { 30: 2_400, 60: 2_600, 90: 2_800, 180: 3_000 };
const FEE_BPS = 100n;
const MAX_LOAN = naira(500_000);
const OFFER_TTL_MINUTES = 10;
const AI_META: Schema<'AiMeta'> = {
  feature: 'credit_scoring',
  model_version: 'rules-mock-1',
  explanation: 'Based on how regularly salary arrives, your average balance and past repayments.',
  fallback_used: true,
};

function monthlySalary(bank: MockBank): Money {
  const since = addDays(bank.now(), -92).toISOString();
  const salaries = customerTransactions(bank).filter(
    (t) => t.category === 'salary_income' && t.amount.currency === 'NGN' && t.created_at >= since,
  );
  const total = salaries.reduce((s, t) => s + BigInt(t.amount.amount_minor), 0n);
  return money(total / 3n, 'NGN');
}

function outstanding(bank: MockBank, loan: LoanRecord): Money {
  const balance = bank.ledger.account(loan.loanAccountId).balance;
  return money(balance.amount < 0n ? -balance.amount : 0n, 'NGN');
}

const DAY_MS = 86_400_000;

/**
 * Paying off early (CRD-4): the interest for the days not yet used is given
 * back, rounded up in the customer's favour and never more than is owed.
 */
function payoffRebate(bank: MockBank, loan: LoanRecord, owed: Money): Money {
  const interest = simpleInterest(fromApi(loan.principal), loan.apr_bps, loan.tenor_days);
  const used = Math.floor((bank.now().getTime() - Date.parse(loan.disbursed_at)) / DAY_MS);
  const left = BigInt(Math.max(0, loan.tenor_days - used));
  const rebate = divideRounded(interest.amount * left, BigInt(loan.tenor_days), 'ceil');
  return money(rebate < owed.amount ? rebate : owed.amount, 'NGN');
}

function schedule(total: Money, tenorDays: number, start: Date): Schema<'Installment'>[] {
  const count = Math.max(1, Math.round(tenorDays / 30));
  const each = total.amount / BigInt(count);
  return Array.from({ length: count }, (_, i) => ({
    number: i + 1,
    due_date: isoDate(addDays(start, 30 * (i + 1))),
    // The last instalment carries the kobo that do not divide evenly.
    amount: api(money(i === count - 1 ? total.amount - each * BigInt(count - 1) : each, 'NGN')),
    paid: api(zero('NGN')),
    status: 'upcoming',
  }));
}

function loanView(bank: MockBank, loan: LoanRecord): Schema<'Loan'> {
  const { loanAccountId: _l, repaymentAccountId: _r, ...rest } = loan;
  const owed = outstanding(bank, loan);
  const total = loan.schedule.reduce((s, i) => s + BigInt(i.amount.amount_minor), 0n);
  let paid = total - owed.amount;
  const today = isoDate(bank.now());
  const installments = loan.schedule.map((i) => {
    const amount = BigInt(i.amount.amount_minor);
    const covered = paid >= amount ? amount : paid > 0n ? paid : 0n;
    paid -= covered;
    const status: Schema<'Installment'>['status'] =
      covered === amount
        ? 'paid'
        : i.due_date < today
          ? 'overdue'
          : i.due_date === today
            ? 'due'
            : 'upcoming';
    return { ...i, paid: api(money(covered, 'NGN')), status };
  });
  const status =
    owed.amount === 0n
      ? 'repaid'
      : installments.some((i) => i.status === 'overdue')
        ? 'overdue'
        : 'active';
  return {
    ...rest,
    status,
    outstanding: api(owed),
    schedule: installments,
    next_due: installments.find((i) => i.status !== 'paid') ?? null,
    ...(owed.amount > 0n && {
      payoff_amount: api(money(owed.amount - payoffRebate(bank, loan, owed).amount, 'NGN')),
    }),
  };
}

/**
 * One repayment posting. With a `rebate` (paying off early) the loan account is
 * cleared by the payment plus the unused interest, which comes back out of
 * interest income, so the posting still balances.
 */
function repay(
  bank: MockBank,
  loan: LoanRecord,
  from: string,
  amount: Money,
  key: string,
  rebate: Money = zero('NGN'),
) {
  const postings = [
    { accountId: from, amount: negate(amount) },
    { accountId: loan.loanAccountId, amount: money(amount.amount + rebate.amount, 'NGN') },
  ];
  if (rebate.amount > 0n) {
    postings.push({
      accountId: bank.ledger.systemAccount('interest_income', 'NGN').id,
      amount: negate(rebate),
    });
  }
  bank.ledger.post({
    kind: 'loan_repayment',
    reference: bank.reference('LON'),
    idempotencyKey: key,
    postings,
    metadata: {
      txns: [
        {
          id: bank.id(),
          accountId: from,
          direction: 'debit',
          type: 'loan_repayment',
          category: 'fees_charges',
          narration: 'Loan repayment',
          counterparty: { name: 'Nem Credit' },
        },
      ],
    },
  });
}

/** Auto-repay (CRD-3): due instalments are collected from the repayment account. */
export function processLoans(bank: MockBank): boolean {
  let changed = false;
  for (const loan of bank.world.loans) {
    if (!loan.auto_repay) continue;
    const view = loanView(bank, loan);
    const due = view.schedule.filter((i) => i.status === 'due' || i.status === 'overdue');
    for (const installment of due) {
      const remaining =
        BigInt(installment.amount.amount_minor) - BigInt(installment.paid.amount_minor);
      const available = bank.ledger.available(loan.repaymentAccountId).amount;
      const take = remaining < available ? remaining : available;
      if (take <= 0n) continue;
      try {
        repay(
          bank,
          loan,
          loan.repaymentAccountId,
          money(take, 'NGN'),
          `auto-repay:${loan.id}:${installment.number}:${take}`,
        );
        changed = true;
      } catch (error) {
        if (!isApiError(error)) throw error;
      }
    }
  }
  return changed;
}

export function creditRepo(bank: MockBank): CreditRepo {
  const find = (id: string) => {
    const l = bank.world.loans.find((x) => x.id === id);
    if (!l) throw notFound('Loan');
    return l;
  };
  const eligibility = (): Schema<'CreditEligibility'> => {
    const salary = monthlySalary(bank);
    const active = bank.world.loans.some((l) => loanView(bank, l).status !== 'repaid');
    const reasons: Schema<'ReasonCode'>[] = [];
    if (salary.amount > 0n) {
      reasons.push({
        code: 'regular_salary',
        impact: 'positive',
        message: 'Your salary arrives on time every month.',
      });
    } else {
      reasons.push({
        code: 'no_salary',
        impact: 'negative',
        message: 'We could not see a regular income yet.',
      });
    }
    if (bank.world.goals.length > 0) {
      reasons.push({ code: 'savings_habit', impact: 'positive', message: 'You save regularly.' });
    }
    if (active)
      reasons.push({
        code: 'active_loan',
        impact: 'negative',
        message: 'Repay your current loan first.',
      });
    if (bank.tier() < 3)
      reasons.push({ code: 'kyc_tier', impact: 'negative', message: 'Credit needs KYC Tier 3.' });
    // Up to 30% of a month's salary, in ₦5,000 steps, capped.
    const third = percentOf(salary, 3_000n, 'floor').amount;
    const stepped = (third / 500_000n) * 500_000n;
    const max = money(stepped < MAX_LOAN.amount ? stepped : MAX_LOAN.amount, 'NGN');
    const eligible = !active && bank.tier() >= 3 && max.amount > 0n;
    return {
      eligible,
      max_amount: api(eligible ? max : zero('NGN')),
      score_band:
        salary.amount >= naira(500_000).amount ? 'good' : salary.amount > 0n ? 'fair' : 'poor',
      reasons,
      ai: AI_META,
      checked_at: bank.nowIso(),
    };
  };

  return {
    async getEligibility() {
      return eligibility();
    },
    async createOffer({ body }) {
      const check = eligibility();
      const principal = positive(body.amount, 'NGN');
      if (!check.eligible) throw problem(422, 'not_eligible', 'You cannot borrow right now');
      if (principal.amount > fromApi(check.max_amount).amount) {
        throw problem(422, 'limit_exceeded', 'That is more than you can borrow');
      }
      const apr = APR_BPS[body.tenor_days];
      const interest = simpleInterest(principal, apr, body.tenor_days);
      const fees = money(divideRounded(principal.amount * FEE_BPS, 10_000n, 'half-up'), 'NGN');
      const total = money(principal.amount + interest.amount + fees.amount, 'NGN');
      const offer: Schema<'LoanOffer'> = {
        offer_id: bank.id(),
        principal: api(principal),
        tenor_days: body.tenor_days,
        apr_bps: apr,
        interest: api(interest),
        fees: api(fees),
        total_repayment: api(total),
        schedule: schedule(total, body.tenor_days, bank.now()),
        expires_at: addMinutes(bank.now(), OFFER_TTL_MINUTES).toISOString(),
      };
      bank.world.loanOffers[offer.offer_id] = offer;
      return offer;
    },
    async listLoans() {
      return { data: bank.world.loans.map((l) => loanView(bank, l)) };
    },
    async acceptOffer({ body, idempotencyKey }) {
      const loan = bank.idempotent(
        idempotencyKey,
        body,
        (id) => bank.world.loans.find((l) => l.id === id),
        () => {
          bank.requireTier(3, 'Credit');
          const offer = bank.world.loanOffers[body.offer_id];
          if (!offer) throw notFound('Offer');
          if (offer.expires_at < bank.nowIso())
            throw problem(410, 'offer_expired', 'This offer has expired');
          const to = bank.ownAccount(body.disbursement_account_id);
          if (to.currency !== 'NGN')
            throw problem(422, 'validation_failed', 'Loans are paid into your naira account');
          const loanAccountId = bank.ledger.openAccount({
            ownerType: 'customer',
            ownerId: bank.user.id,
            kind: 'customer_loan',
            currency: 'NGN',
          }).id;
          const principal = fromApi(offer.principal);
          const interest = fromApi(offer.interest);
          const fees = fromApi(offer.fees);
          const total = fromApi(offer.total_repayment);
          const postings = [
            { accountId: loanAccountId, amount: negate(total) },
            { accountId: to.id, amount: principal },
            { accountId: bank.ledger.systemAccount('interest_income', 'NGN').id, amount: interest },
          ];
          if (fees.amount > 0n)
            postings.push({
              accountId: bank.ledger.systemAccount('fee_income', 'NGN').id,
              amount: fees,
            });
          bank.ledger.post({
            kind: 'loan_disbursement',
            reference: bank.reference('LON'),
            idempotencyKey: `loan:${offer.offer_id}`,
            postings,
            metadata: {
              txns: [
                {
                  id: bank.id(),
                  accountId: to.id,
                  direction: 'credit',
                  type: 'loan_disbursement',
                  category: 'other',
                  narration: 'Nem Credit loan',
                  counterparty: { name: 'Nem Credit' },
                },
              ],
            },
          });
          delete bank.world.loanOffers[offer.offer_id];
          const record: LoanRecord = {
            id: bank.id(),
            loanAccountId,
            repaymentAccountId: to.id,
            principal: offer.principal,
            apr_bps: offer.apr_bps,
            tenor_days: offer.tenor_days,
            status: 'active',
            auto_repay: body.auto_repay,
            schedule: offer.schedule,
            disbursed_at: bank.nowIso(),
          };
          bank.world.loans.push(record);
          return record;
        },
      );
      return loanView(bank, loan);
    },
    async getLoan({ path }) {
      return loanView(bank, find(path.loan_id));
    },
    async updateLoan({ path, body }) {
      const loan = find(path.loan_id);
      loan.auto_repay = body.auto_repay;
      return loanView(bank, loan);
    },
    async repay({ path, body, idempotencyKey }) {
      // A replay (lost response) returns the loan, even once it is fully repaid.
      const loan = bank.idempotent(idempotencyKey, { path, body }, find, () => {
        const record = find(path.loan_id);
        const from = bank.ownAccount(body.account_id);
        const amount = positive(body.amount, 'NGN');
        const owed = outstanding(bank, record);
        if (owed.amount === 0n) throw problem(409, 'invalid_state', 'This loan is fully repaid');
        if (amount.amount > owed.amount)
          throw problem(422, 'validation_failed', 'That is more than you owe');
        // Exactly the payoff amount settles the loan with the unused interest given back.
        const rebate = payoffRebate(bank, record, owed);
        const settles = rebate.amount > 0n && amount.amount === owed.amount - rebate.amount;
        repay(bank, record, from.id, amount, idempotencyKey, settles ? rebate : zero('NGN'));
        return record;
      });
      return loanView(bank, loan);
    },
  };
}
