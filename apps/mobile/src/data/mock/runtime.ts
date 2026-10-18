import type { Schema } from '@nem/contracts';
import type { CurrencyCode, KycTier } from '@nem/shared';

import { problem } from '../errors';
import type { MockBankState } from './bank';
import { saveBank } from './bank';
import { addDays, fromApi } from './convert';
import { createIdFactory } from './ids';
import { Ledger, type CustomerLimits, type LedgerAccount } from './ledger';
import type { SnapshotStore } from './persistence/types';
import type { World } from './world';

/** Returns true when it changed something, so the caller knows to save. */
type Task = (bank: MockBank) => boolean;

// Bigint is not JSON; fingerprints compare request bodies for idempotency.
export const fingerprint = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

/**
 * The running mock bank: state, ledger, clock and persistence in one place. Domain
 * repositories (./domains) are thin use cases on top of it.
 */
export class MockBank {
  readonly ledger: Ledger;
  readonly id: () => string;
  private saving: Promise<void> = Promise.resolve();
  private readonly tasks: Task[] = [];

  constructor(
    readonly state: MockBankState,
    private readonly store: SnapshotStore,
    private readonly clock: () => Date = () => new Date(),
    /** Demo Controls reset swaps the whole bank; the owner of the bank provides it. */
    readonly reset: () => Promise<void> = async () => undefined,
  ) {
    this.id = createIdFactory(() => this.now());
    this.ledger = new Ledger(state.ledger, { now: () => this.now(), newId: this.id });
  }

  get world(): World {
    return this.state.world;
  }

  get user() {
    return this.state.user;
  }

  /** The device clock plus any Demo Controls time travel. */
  now(): Date {
    return addDays(this.clock(), this.world.clockOffsetDays);
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  /** Human-readable reference, like the server's: NEM + Lagos date + sequence. */
  reference(prefix = 'NEM'): string {
    this.world.sequence += 1;
    const date = this.nowIso().slice(0, 10).replaceAll('-', '');
    return `${prefix}${date}${this.world.sequence.toString(36).toUpperCase().padStart(6, '0')}`;
  }

  /** Writes are queued so two quick mutations never interleave on disk. */
  save(): Promise<void> {
    this.saving = this.saving.then(() => saveBank(this.store, this.state)).catch(() => undefined);
    return this.saving;
  }

  /** Work that becomes due with time: partner callbacks, schedules, delays. */
  onTick(task: Task): void {
    this.tasks.push(task);
  }

  tick(): boolean {
    let changed = this.ledger.expireHolds().length > 0;
    for (const task of this.tasks) changed = task(this) || changed;
    return changed;
  }

  tier(): KycTier {
    return this.user.kyc_tier;
  }

  limits(): CustomerLimits {
    const daily = this.world.selfLimits.daily;
    return { tier: this.tier(), selfDailyLimit: daily ? fromApi(daily) : null };
  }

  /** The customer's own spendable accounts (current account and FX wallets). */
  customerAccounts(): LedgerAccount[] {
    return Object.values(this.ledger.state.accounts).filter(
      (a) =>
        a.ownerType === 'customer' &&
        a.ownerId === this.user.id &&
        (a.kind === 'customer_current' || a.kind === 'customer_wallet'),
    );
  }

  /** One of the customer's accounts, or a 404 (never someone else's). */
  ownAccount(accountId: string): LedgerAccount {
    const account = this.customerAccounts().find((a) => a.id === accountId);
    if (!account) throw problem(404, 'not_found', 'Account not found');
    return account;
  }

  accountIn(currency: CurrencyCode): LedgerAccount | undefined {
    return this.customerAccounts().find((a) => a.currency === currency);
  }

  /** SEC-4: the panic button blocks every outgoing payment until it is released. */
  assertCanSend(): void {
    if (this.world.panic.active) {
      throw problem(403, 'outgoing_blocked', 'Outgoing payments are paused', {
        detail: 'Panic mode is on. Release it in the Security Center to send money again.',
      });
    }
  }

  requireTier(tier: KycTier, what: string): void {
    if (this.tier() < tier) {
      throw problem(403, 'kyc_tier_required', `${what} needs KYC Tier ${tier}`, {
        detail: 'Verify your identity in Profile → Verification to unlock it.',
      });
    }
  }

  /** Checks and spends a single-use step-up token for `purpose`. */
  consumeStepUp(token: string | undefined, purpose: Schema<'StepUpPurpose'>): void {
    const record = token ? this.world.stepUpTokens[token] : undefined;
    if (!token || !record || record.purpose !== purpose || record.expiresAt < this.nowIso()) {
      throw problem(403, 'step_up_required', 'Confirm it is you first', {
        detail: `This needs a fresh ${purpose.replaceAll('_', ' ')} verification.`,
      });
    }
    delete this.world.stepUpTokens[token];
  }

  hasValidStepUp(token: string | undefined, purpose: Schema<'StepUpPurpose'>): boolean {
    try {
      this.consumeStepUp(token, purpose);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Replays a stored result for a repeated idempotency key, rejects the same key
   * with a different body, and otherwise runs `create` once.
   */
  idempotent<T extends { id: string }>(
    key: string,
    body: unknown,
    find: (id: string) => T | undefined,
    create: () => T,
  ): T {
    const seen = this.world.idempotency[key];
    const print = fingerprint(body ?? null);
    if (seen) {
      if (seen.fingerprint !== print) {
        throw problem(422, 'idempotency_conflict', 'This request was already sent', {
          detail: 'The same idempotency key was used with a different request.',
        });
      }
      const replay = find(seen.id);
      if (replay) return replay;
    }
    const result = create();
    this.world.idempotency[key] = { fingerprint: print, id: result.id };
    return result;
  }

  notify(input: Omit<Schema<'Notification'>, 'id' | 'read' | 'created_at'>): void {
    this.world.notifications.push({
      ...input,
      id: this.id(),
      read: false,
      created_at: this.nowIso(),
    });
  }
}
