import type { Schema } from '@nem/contracts';
import type { CurrencyCode, Money } from '@nem/shared';

// The mock ledger mirrors the server's tables (architecture §4): accounts,
// journal entries with signed postings, and holds. Amounts are bigint Money.

export type LedgerAccountKind = Schema<'LedgerAccountKind'>;
export type JournalEntryKind = Schema<'JournalEntryKind'>;
export type HoldReason = Schema<'HoldReason'>;
export type AccountStatus = Schema<'AccountStatus'>;

export interface LedgerAccount {
  id: string;
  ownerType: Schema<'LedgerOwnerType'>;
  ownerId: string | null;
  kind: LedgerAccountKind;
  currency: CurrencyCode;
  status: AccountStatus;
  /** Sum of every posting: credits positive, debits negative. */
  balance: Money;
  /** Bumped on every change, like the server's optimistic-lock column. */
  version: number;
  createdAt: string;
}

export interface Posting {
  id: string;
  entryId: string;
  accountId: string;
  /** Signed: credits positive, debits negative. */
  amount: Money;
  balanceAfter: Money;
  createdAt: string;
}

export interface JournalEntry {
  id: string;
  kind: JournalEntryKind;
  reference: string;
  idempotencyKey: string | null;
  postings: Posting[];
  metadata: Record<string, unknown>;
  /** Principal that counts toward the customer's daily limit, if any. */
  limitUsage: { accountId: string; amount: Money } | null;
  createdAt: string;
}

export type HoldStatus = 'active' | 'captured' | 'released';

export interface Hold {
  id: string;
  accountId: string;
  amount: Money;
  reason: HoldReason;
  reference: string;
  status: HoldStatus;
  /** Principal that counts toward the daily limit while the hold is active. */
  limitUsage: Money | null;
  createdAt: string;
  expiresAt: string | null;
}

/** Everything the ledger knows. Plain data, so persistence (T3.6) can snapshot it. */
export interface LedgerState {
  accounts: Record<string, LedgerAccount>;
  entries: JournalEntry[];
  holds: Record<string, Hold>;
  /** Idempotency key → request fingerprint and the entry it produced. */
  idempotency: Record<string, { fingerprint: string; entryId: string }>;
}

export const emptyLedgerState = (): LedgerState => ({
  accounts: {},
  entries: [],
  holds: {},
  idempotency: {},
});

/** Injected so tests, the seed and Demo Controls time travel stay deterministic. */
export interface LedgerDeps {
  now: () => Date;
  newId: () => string;
}
