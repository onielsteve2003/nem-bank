import type { Schema, User } from '@nem/contracts';

import { addDemoAuthorizations } from './cardAuthorizations';
import { Ledger, type LedgerState } from './ledger';
import { deserialize, serialize } from './persistence/serialize';
import type { SnapshotStore } from './persistence/types';
import { createIdFactory } from './ids';
import { seedDemoBank } from './seed';
import { addFriendPayLink } from './seedWorld';
import type { World } from './world';

/** What a transaction looks like from the customer's side, kept on its journal entry. */
export interface TransactionMeta {
  /** The customer-facing transaction ID (one entry can be two transactions, e.g. FX). */
  id: string;
  accountId: string;
  type: Schema<'TransactionType'>;
  direction: Schema<'Direction'>;
  category: Schema<'Category'>;
  narration: string;
  counterparty: Schema<'Counterparty'>;
  transferId?: string | null;
  cardId?: string | null;
}

/** The whole mock bank, saved as one snapshot. */
export interface MockBankState {
  /** Bump when the shape changes: an old snapshot is then replaced by a fresh seed. */
  schemaVersion: typeof SCHEMA_VERSION;
  seed: number;
  seededAt: string;
  user: User;
  accounts: { ngn: string; usd: string };
  ledger: LedgerState;
  world: World;
}

export const SCHEMA_VERSION = 2;
export const SNAPSHOT_KEY = 'bank';
export const DEFAULT_SEED = 2026;

export async function saveBank(store: SnapshotStore, bank: MockBankState): Promise<void> {
  await store.write(SNAPSHOT_KEY, serialize(bank));
}

/**
 * Loads the saved bank, or seeds a fresh demo persona when there is none, the
 * snapshot is from an older schema, or it cannot be read.
 */
export async function loadOrSeedBank(
  store: SnapshotStore,
  options: { now?: Date; seed?: number } = {},
): Promise<MockBankState> {
  const text = await store.read(SNAPSHOT_KEY);
  if (text) {
    try {
      const saved = deserialize<MockBankState>(text);
      if (saved.schemaVersion === SCHEMA_VERSION) {
        // Demo data added after a bank was saved is filled in, keeping the customer's history.
        addFriendPayLink(saved.world, createIdFactory(() => new Date())(), saved.seededAt);
        if (!('cardAuthorizations' in saved.world)) {
          (saved.world as World).cardAuthorizations = [];
          placeDemoAuthorizations(saved, options.now ?? new Date());
        }
        return saved;
      }
    } catch {
      // A corrupt snapshot is replaced; demo data is disposable by design.
    }
  }
  const now = options.now ?? new Date();
  const bank = seedDemoBank({ now, seed: options.seed ?? DEFAULT_SEED });
  placeDemoAuthorizations(bank, now);
  await saveBank(store, bank);
  return bank;
}

/**
 * Card payments still waiting to settle, timed from the device clock rather than
 * the seed, which must stay the same all day for a given seed.
 */
function placeDemoAuthorizations(bank: MockBankState, deviceNow: Date): void {
  const newId = createIdFactory(() => new Date());
  const now = () => new Date(deviceNow.getTime() + bank.world.clockOffsetDays * 86_400_000);
  addDemoAuthorizations(new Ledger(bank.ledger, { now, newId }), bank.world, newId, now());
}

/** Demo Controls "reset": throw the snapshot away and seed again. */
export async function resetBank(
  store: SnapshotStore,
  options: { now?: Date; seed?: number } = {},
): Promise<MockBankState> {
  await store.remove(SNAPSHOT_KEY);
  return loadOrSeedBank(store, options);
}
