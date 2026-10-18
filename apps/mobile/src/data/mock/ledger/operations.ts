import {
  add,
  convertAtRate,
  emtlFor,
  formatMoney,
  KYC_TIERS,
  negate,
  transferFee,
  zero,
  type KycTier,
  type Money,
} from '@nem/shared';

import { problem } from '../../errors';
import type { Ledger } from './ledger';
import type { Hold, JournalEntry } from './types';

// Banking operations on top of the posting engine: fees, KYC limits, holds and FX.
// Each mirrors one server use case, so the demo behaves like the real bank.

export interface CustomerLimits {
  tier: KycTier;
  /** The customer's own lower daily cap (Security Center), if set. */
  selfDailyLimit?: Money | null;
}

/** Calendar day in Lagos (WAT, UTC+1, no daylight saving): when daily limits reset. */
export const lagosDay = (iso: string) =>
  new Date(Date.parse(iso) + 60 * 60 * 1000).toISOString().slice(0, 10);

/** Principal sent today from an account: settled entries plus pending transfer holds. */
export function spentToday(ledger: Ledger, accountId: string, nowIso: string): Money {
  const today = lagosDay(nowIso);
  const currency = ledger.account(accountId).currency;
  const settled = ledger.state.entries
    .filter((e) => e.limitUsage?.accountId === accountId && lagosDay(e.createdAt) === today)
    .map((e) => e.limitUsage!.amount);
  const pending = ledger
    .activeHolds(accountId)
    .filter((h) => h.limitUsage && lagosDay(h.createdAt) === today)
    .map((h) => h.limitUsage!);
  return [...settled, ...pending].reduce(add, zero(currency));
}

export function assertWithinDailyLimit(
  ledger: Ledger,
  accountId: string,
  amount: Money,
  limits: CustomerLimits,
  nowIso: string,
): void {
  const tierLimit = KYC_TIERS[limits.tier].dailyLimit;
  const self = limits.selfDailyLimit;
  const limit = self && self.amount < tierLimit.amount ? self : tierLimit;
  const remaining = limit.amount - spentToday(ledger, accountId, nowIso).amount;
  if (amount.amount > remaining) {
    throw problem(422, 'limit_exceeded', 'Daily limit reached', {
      detail: `You can send ${formatMoney({ amount: remaining > 0n ? remaining : 0n, currency: amount.currency })} more today.`,
    });
  }
}

/** NGN accounts have a KYC balance cap on Tiers 1 and 2. */
export function assertWithinMaxBalance(
  ledger: Ledger,
  accountId: string,
  credit: Money,
  tier: KycTier,
): void {
  const cap = KYC_TIERS[tier].maxBalance;
  const account = ledger.account(accountId);
  if (!cap || account.currency !== cap.currency) return;
  if (account.balance.amount + credit.amount > cap.amount) {
    throw problem(422, 'max_balance_exceeded', 'This would go over your balance limit', {
      detail: `Tier ${tier} accounts can hold up to ${formatMoney(cap)}. Upgrade your KYC tier to receive more.`,
    });
  }
}

interface TransferInput {
  fromAccountId: string;
  amount: Money;
  reference: string;
  idempotencyKey: string;
  limits: CustomerLimits;
  metadata?: Record<string, unknown>;
}

/** Nem-to-Nem: free and instant, one entry. */
export function transferInternal(
  ledger: Ledger,
  input: TransferInput & { toAccountId: string; recipientTier: KycTier },
): JournalEntry {
  // A replay returns the stored entry; the rules were checked the first time.
  if (!ledger.state.idempotency[input.idempotencyKey]) {
    assertWithinDailyLimit(
      ledger,
      input.fromAccountId,
      input.amount,
      input.limits,
      ledgerNow(ledger),
    );
    assertWithinMaxBalance(ledger, input.toAccountId, input.amount, input.recipientTier);
  }
  return ledger.post({
    kind: 'transfer_internal',
    reference: input.reference,
    idempotencyKey: input.idempotencyKey,
    postings: [
      { accountId: input.fromAccountId, amount: negate(input.amount) },
      { accountId: input.toAccountId, amount: input.amount },
    ],
    metadata: input.metadata,
    limitUsage: { accountId: input.fromAccountId, amount: input.amount },
  });
}

const ledgerNow = (ledger: Ledger) => ledger.now().toISOString();

/**
 * External (NIP) transfers hold the amount plus fee first, then settle or fail
 * when the partner answers, like the server's saga.
 */
export function startExternalTransfer(ledger: Ledger, input: TransferInput): Hold {
  const nowIso = ledgerNow(ledger);
  assertWithinDailyLimit(ledger, input.fromAccountId, input.amount, input.limits, nowIso);
  const fee = transferFee(input.amount, 'external');
  return ledger.placeHold({
    accountId: input.fromAccountId,
    amount: add(input.amount, fee),
    reason: 'pending_transfer',
    reference: input.reference,
    limitUsage: input.amount,
  });
}

export function settleExternalTransfer(
  ledger: Ledger,
  holdId: string,
  idempotencyKey: string,
  metadata: Record<string, unknown> = {},
): JournalEntry {
  const hold = ledger.state.holds[holdId];
  if (!hold) throw problem(404, 'hold_not_found', 'Hold not found');
  // The idempotency key makes a duplicate partner callback replay, not double-settle.
  const seen = ledger.state.idempotency[idempotencyKey];
  if (seen) return ledger.state.entries.find((e) => e.id === seen.entryId)!;
  const entry = settlementEntry(ledger, hold);
  return ledger.post({ ...entry, idempotencyKey, metadata: { ...metadata, ...entry.metadata } });
}

function settlementEntry(ledger: Ledger, hold: Hold) {
  const amount = hold.limitUsage ?? hold.amount;
  const fee = add(hold.amount, negate(amount));
  const currency = hold.amount.currency;
  const postings = [
    { accountId: hold.accountId, amount: negate(hold.amount) },
    { accountId: ledger.systemAccount('partner_settlement', currency).id, amount },
  ];
  if (fee.amount > 0n) {
    postings.push({ accountId: ledger.systemAccount('fee_income', currency).id, amount: fee });
  }
  return {
    kind: 'transfer_external' as const,
    reference: hold.reference,
    postings,
    captureHoldIds: [hold.id],
    limitUsage: { accountId: hold.accountId, amount },
    metadata: { fee: fee.amount.toString() },
  };
}

/** The partner rejected the transfer: the held funds (and the limit) come back. */
export function failExternalTransfer(ledger: Ledger, holdId: string): Hold {
  return ledger.releaseHold(holdId);
}

/** Refunds a settled entry in full by posting its mirror image. */
export function reverseEntry(
  ledger: Ledger,
  entryId: string,
  idempotencyKey: string,
): JournalEntry {
  const original = ledger.state.entries.find((e) => e.id === entryId);
  if (!original) throw problem(404, 'entry_not_found', 'Entry not found');
  return ledger.post({
    kind: 'transfer_reversal',
    reference: `reversal:${original.reference}`,
    idempotencyKey,
    postings: original.postings.map((p) => ({ accountId: p.accountId, amount: negate(p.amount) })),
    metadata: { reverses: original.id },
  });
}

/**
 * Money arriving from another bank. The EMTL levy (₦50 on ₦10,000+) is taken in the
 * same entry, so the customer never sees the gross credit without the levy.
 */
export function receiveExternal(
  ledger: Ledger,
  input: {
    toAccountId: string;
    amount: Money;
    tier: KycTier;
    reference: string;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  },
): JournalEntry {
  const currency = input.amount.currency;
  if (!ledger.state.idempotency[input.idempotencyKey]) {
    assertWithinMaxBalance(ledger, input.toAccountId, input.amount, input.tier);
  }
  const levy = emtlFor(input.amount);
  const postings = [
    {
      accountId: ledger.systemAccount('partner_settlement', currency).id,
      amount: negate(input.amount),
    },
    { accountId: input.toAccountId, amount: input.amount },
  ];
  if (levy.amount > 0n) {
    postings.push(
      { accountId: input.toAccountId, amount: negate(levy) },
      { accountId: ledger.systemAccount('levy_payable', currency).id, amount: levy },
    );
  }
  return ledger.post({
    kind: 'transfer_external',
    reference: input.reference,
    idempotencyKey: input.idempotencyKey,
    postings,
    metadata: { ...input.metadata, levy: levy.amount.toString() },
  });
}

/** Demo Controls "fund wallet": simulated money from the demo funding account. */
export function demoFund(
  ledger: Ledger,
  input: {
    toAccountId: string;
    amount: Money;
    tier: KycTier;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  },
): JournalEntry {
  if (!ledger.state.idempotency[input.idempotencyKey]) {
    assertWithinMaxBalance(ledger, input.toAccountId, input.amount, input.tier);
  }
  return ledger.post({
    kind: 'demo_funding',
    reference: 'demo:fund',
    idempotencyKey: input.idempotencyKey,
    postings: [
      {
        accountId: ledger.systemAccount('demo_funding', input.amount.currency).id,
        amount: negate(input.amount),
      },
      { accountId: input.toAccountId, amount: input.amount },
    ],
    metadata: input.metadata,
  });
}

/**
 * Converts between two of the customer's wallets at a quoted customer rate.
 * Each currency balances on its own through that currency's FX position account,
 * so the books never mix naira and dollars in one sum.
 */
export function convertFx(
  ledger: Ledger,
  input: {
    fromAccountId: string;
    toAccountId: string;
    sell: Money;
    /** Customer rate (spread already applied): units of `to` per one unit of `sell`. */
    rate: string;
    reference: string;
    idempotencyKey: string;
    toTier: KycTier;
    metadata?: Record<string, unknown>;
  },
): { entry: JournalEntry; buy: Money } {
  const to = ledger.account(input.toAccountId);
  if (input.sell.currency === to.currency) {
    throw problem(422, 'validation_failed', 'Pick two different currencies');
  }
  // The customer buys, so a fractional minor unit rounds down (in the bank's favour).
  const buy = convertAtRate(input.sell, input.rate, to.currency, 'floor');
  if (buy.amount <= 0n)
    throw problem(422, 'validation_failed', 'The amount is too small to convert');
  if (!ledger.state.idempotency[input.idempotencyKey]) {
    assertWithinMaxBalance(ledger, to.id, buy, input.toTier);
  }
  const entry = ledger.post({
    kind: 'fx_conversion',
    reference: input.reference,
    idempotencyKey: input.idempotencyKey,
    postings: [
      { accountId: input.fromAccountId, amount: negate(input.sell) },
      {
        accountId: ledger.systemAccount('fx_position', input.sell.currency).id,
        amount: input.sell,
      },
      { accountId: ledger.systemAccount('fx_position', to.currency).id, amount: negate(buy) },
      { accountId: to.id, amount: buy },
    ],
    metadata: { ...input.metadata, rate: input.rate },
  });
  return { entry, buy };
}
