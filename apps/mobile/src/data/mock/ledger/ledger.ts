import { add, negate, zero, type CurrencyCode, type Money } from '@nem/shared';

import { problem } from '../../errors';
import type {
  Hold,
  HoldReason,
  JournalEntry,
  JournalEntryKind,
  LedgerAccount,
  LedgerAccountKind,
  LedgerDeps,
  LedgerState,
} from './types';

export interface PostingInput {
  accountId: string;
  /** Signed: credits positive, debits negative. */
  amount: Money;
}

export interface EntryInput {
  kind: JournalEntryKind;
  reference: string;
  postings: PostingInput[];
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  /** Holds settled by this entry: released in the same step as the postings. */
  captureHoldIds?: string[];
  limitUsage?: { accountId: string; amount: Money };
}

export interface HoldInput {
  accountId: string;
  amount: Money;
  reason: HoldReason;
  reference: string;
  expiresAt?: string | null;
  limitUsage?: Money;
}

/**
 * Customer money is a liability the bank owes, so it may never go below zero.
 * System accounts (settlement, FX positions, demo funding) and loan receivables
 * carry the other side of every entry and may go negative.
 */
const MAY_GO_NEGATIVE: ReadonlySet<LedgerAccountKind> = new Set([
  'customer_loan',
  'fee_income',
  'fx_position',
  'interest_expense',
  'interest_income',
  'ajo_escrow',
  'card_settlement',
  'partner_settlement',
  'levy_payable',
  'demo_funding',
  'suspense',
]);

// Bigint is not JSON; fingerprints compare requests for idempotency.
const fingerprint = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

/**
 * The mock bank's posting engine. Every balance change goes through `post`, which
 * enforces the same rules as the server: each entry balances per currency, no
 * customer's available balance goes negative, and idempotency keys replay.
 */
export class Ledger {
  constructor(
    readonly state: LedgerState,
    private readonly deps: LedgerDeps,
  ) {}

  now(): Date {
    return this.deps.now();
  }

  private timestamp(): string {
    return this.deps.now().toISOString();
  }

  account(id: string): LedgerAccount {
    const account = this.state.accounts[id];
    if (!account) throw problem(404, 'account_not_found', 'Account not found');
    return account;
  }

  openAccount(input: {
    ownerType: LedgerAccount['ownerType'];
    ownerId: string | null;
    kind: LedgerAccountKind;
    currency: CurrencyCode;
    id?: string;
  }): LedgerAccount {
    const account: LedgerAccount = {
      id: input.id ?? this.deps.newId(),
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      kind: input.kind,
      currency: input.currency,
      status: 'active',
      balance: zero(input.currency),
      version: 0,
      createdAt: this.timestamp(),
    };
    this.state.accounts[account.id] = account;
    return account;
  }

  /** The single system account of a kind per currency, created on first use. */
  systemAccount(kind: LedgerAccountKind, currency: CurrencyCode): LedgerAccount {
    const existing = Object.values(this.state.accounts).find(
      (a) => a.ownerType === 'system' && a.kind === kind && a.currency === currency,
    );
    return existing ?? this.openAccount({ ownerType: 'system', ownerId: null, kind, currency });
  }

  setStatus(accountId: string, status: LedgerAccount['status']): void {
    const account = this.account(accountId);
    account.status = status;
    account.version += 1;
  }

  activeHolds(accountId: string): Hold[] {
    return Object.values(this.state.holds).filter(
      (h) => h.accountId === accountId && h.status === 'active',
    );
  }

  /** Ledger balance minus active holds. */
  available(accountId: string, excludingHoldIds: readonly string[] = []): Money {
    const account = this.account(accountId);
    return this.activeHolds(accountId)
      .filter((h) => !excludingHoldIds.includes(h.id))
      .reduce((total, h) => add(total, negate(h.amount)), account.balance);
  }

  private assertCanDebit(account: LedgerAccount, newAvailable: Money): void {
    if (account.status !== 'active') {
      throw problem(403, 'account_frozen', 'This account cannot send money right now', {
        detail: `The account is ${account.status}.`,
      });
    }
    if (account.ownerType === 'customer' && !MAY_GO_NEGATIVE.has(account.kind)) {
      if (newAvailable.amount < 0n) {
        throw problem(422, 'insufficient_funds', 'Insufficient funds');
      }
    }
  }

  post(input: EntryInput): JournalEntry {
    if (input.idempotencyKey) {
      const seen = this.state.idempotency[input.idempotencyKey];
      if (seen) {
        if (seen.fingerprint !== fingerprint(input)) {
          throw problem(422, 'idempotency_conflict', 'This request was already sent', {
            detail: 'The same idempotency key was used with a different request.',
          });
        }
        const replay = this.state.entries.find((e) => e.id === seen.entryId);
        if (replay) return replay;
      }
    }

    if (input.postings.length < 2) throw new Error('An entry needs at least two postings');

    // Balance check per currency: a programming error, not a customer error.
    const totals = new Map<CurrencyCode, bigint>();
    for (const p of input.postings) {
      const account = this.account(p.accountId);
      if (p.amount.currency !== account.currency) {
        throw problem(422, 'currency_mismatch', 'Currency mismatch', {
          detail: `A ${p.amount.currency} posting cannot go to a ${account.currency} account.`,
        });
      }
      if (p.amount.amount === 0n) throw new Error('Postings must be non-zero');
      totals.set(p.amount.currency, (totals.get(p.amount.currency) ?? 0n) + p.amount.amount);
    }
    for (const [currency, total] of totals) {
      if (total !== 0n) throw new Error(`Entry does not balance in ${currency}: ${total}`);
    }

    const captured = (input.captureHoldIds ?? []).map((id) => {
      const hold = this.state.holds[id];
      if (!hold || hold.status !== 'active') {
        throw problem(409, 'hold_not_active', 'The hold is no longer active');
      }
      return hold;
    });

    // Validate every account before changing any, so a failed entry changes nothing.
    const deltas = new Map<string, Money>();
    for (const p of input.postings) {
      const current = deltas.get(p.accountId);
      deltas.set(p.accountId, current ? add(current, p.amount) : p.amount);
    }
    const capturedIds = captured.map((h) => h.id);
    for (const [accountId, delta] of deltas) {
      if (delta.amount >= 0n) continue;
      const account = this.account(accountId);
      this.assertCanDebit(account, add(this.available(accountId, capturedIds), delta));
    }

    const createdAt = this.timestamp();
    const entryId = this.deps.newId();
    const postings = input.postings.map((p) => {
      const account = this.account(p.accountId);
      account.balance = add(account.balance, p.amount);
      account.version += 1;
      return {
        id: this.deps.newId(),
        entryId,
        accountId: p.accountId,
        amount: p.amount,
        balanceAfter: account.balance,
        createdAt,
      };
    });
    for (const hold of captured) hold.status = 'captured';

    const entry: JournalEntry = {
      id: entryId,
      kind: input.kind,
      reference: input.reference,
      idempotencyKey: input.idempotencyKey ?? null,
      postings,
      metadata: input.metadata ?? {},
      limitUsage: input.limitUsage ?? null,
      createdAt,
    };
    this.state.entries.push(entry);
    if (input.idempotencyKey) {
      this.state.idempotency[input.idempotencyKey] = { fingerprint: fingerprint(input), entryId };
    }
    return entry;
  }

  placeHold(input: HoldInput): Hold {
    const account = this.account(input.accountId);
    if (input.amount.currency !== account.currency) {
      throw problem(422, 'currency_mismatch', 'Currency mismatch');
    }
    if (input.amount.amount <= 0n) throw new Error('Holds must be positive');
    this.assertCanDebit(account, add(this.available(account.id), negate(input.amount)));
    const hold: Hold = {
      id: this.deps.newId(),
      accountId: account.id,
      amount: input.amount,
      reason: input.reason,
      reference: input.reference,
      status: 'active',
      limitUsage: input.limitUsage ?? null,
      createdAt: this.timestamp(),
      expiresAt: input.expiresAt ?? null,
    };
    this.state.holds[hold.id] = hold;
    account.version += 1;
    return hold;
  }

  releaseHold(holdId: string): Hold {
    const hold = this.state.holds[holdId];
    if (!hold || hold.status !== 'active') {
      throw problem(409, 'hold_not_active', 'The hold is no longer active');
    }
    hold.status = 'released';
    this.account(hold.accountId).version += 1;
    return hold;
  }

  /** Releases holds whose expiry has passed (card authorisations that never settled). */
  expireHolds(): Hold[] {
    const now = this.deps.now().getTime();
    return Object.values(this.state.holds)
      .filter((h) => h.status === 'active' && h.expiresAt && Date.parse(h.expiresAt) <= now)
      .map((h) => this.releaseHold(h.id));
  }

  /** Sum of every account per currency. Always zero when the books balance. */
  trialBalance(): Map<CurrencyCode, Money> {
    const totals = new Map<CurrencyCode, Money>();
    for (const account of Object.values(this.state.accounts)) {
      totals.set(
        account.currency,
        add(totals.get(account.currency) ?? zero(account.currency), account.balance),
      );
    }
    return totals;
  }
}
