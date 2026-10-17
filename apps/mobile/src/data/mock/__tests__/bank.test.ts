import { loadOrSeedBank, resetBank, saveBank, SNAPSHOT_KEY, type TransactionMeta } from '../bank';
import { Ledger } from '../ledger';
import { deserialize, serialize } from '../persistence/serialize';
import { createMemoryStore } from '../persistence/types';
import { seedDemoBank } from '../seed';

const NOW = new Date('2026-10-17T12:00:00.000Z');

const txnsOf = (bank: ReturnType<typeof seedDemoBank>) =>
  bank.ledger.entries.flatMap((e) => (e.metadata.txns as TransactionMeta[] | undefined) ?? []);

describe('serialize', () => {
  it('round-trips bigint amounts exactly', () => {
    const value = { a: 12345678901234567890n, nested: [{ b: -5n }], text: 'x' };
    expect(deserialize(serialize(value))).toEqual(value);
  });
});

describe('seedDemoBank', () => {
  const bank = seedDemoBank({ now: NOW, seed: 2026 });
  const ledger = new Ledger(bank.ledger, { now: () => NOW, newId: () => 'unused' });

  it('is deterministic for the same seed and day', () => {
    const sameDayLater = new Date('2026-10-17T21:00:00.000Z');
    expect(serialize(seedDemoBank({ now: sameDayLater, seed: 2026 }))).toBe(serialize(bank));
    expect(serialize(seedDemoBank({ now: NOW, seed: 7 }))).not.toBe(serialize(bank));
  });

  it('creates a demo persona with an NGN account and a USD wallet', () => {
    expect(bank.user).toMatchObject({ preferred_name: 'Tolu', is_demo: true, kyc_tier: 3 });
    expect(ledger.account(bank.accounts.ngn).currency).toBe('NGN');
    expect(ledger.account(bank.accounts.usd).currency).toBe('USD');
  });

  it('covers six months of salary, POS, transport, airtime and subscriptions', () => {
    const txns = txnsOf(bank);
    const salaries = txns.filter((t) => t.narration.startsWith('Salary'));
    expect(salaries).toHaveLength(6);
    for (const category of ['transport', 'food', 'groceries', 'airtime_data', 'subscriptions']) {
      expect(txns.some((t) => t.category === category)).toBe(true);
    }
    expect(txns.some((t) => t.type === 'fx_conversion')).toBe(true);
    expect(txns.length).toBeGreaterThan(400);

    const first = Date.parse(bank.ledger.entries[0]!.createdAt);
    const last = Date.parse(bank.ledger.entries.at(-1)!.createdAt);
    expect((NOW.getTime() - first) / 86_400_000).toBeGreaterThan(180);
    expect(last).toBeLessThan(NOW.getTime());
  });

  it('leaves the books balanced and every balance non-negative', () => {
    for (const total of ledger.trialBalance().values()) expect(total.amount).toBe(0n);
    expect(ledger.available(bank.accounts.ngn).amount > 0n).toBe(true);
    expect(ledger.available(bank.accounts.usd).amount >= 0n).toBe(true);
  });

  it('stays small enough for web localStorage', () => {
    expect(serialize(bank).length).toBeLessThan(2_500_000);
  });
});

describe('loadOrSeedBank', () => {
  it('seeds and saves on first run, then loads the saved snapshot', async () => {
    const store = createMemoryStore();
    const first = await loadOrSeedBank(store, { now: NOW });
    expect(await store.read(SNAPSHOT_KEY)).not.toBeNull();

    first.user.preferred_name = 'Changed';
    await saveBank(store, first);
    const second = await loadOrSeedBank(store, { now: new Date('2026-12-01T00:00:00Z') });
    expect(second.user.preferred_name).toBe('Changed');
    expect(second.ledger.entries).toHaveLength(first.ledger.entries.length);
  });

  it('replaces corrupt or outdated snapshots with a fresh seed', async () => {
    const corrupt = createMemoryStore({ [SNAPSHOT_KEY]: '{not json' });
    expect((await loadOrSeedBank(corrupt, { now: NOW })).schemaVersion).toBe(1);

    const outdated = createMemoryStore({ [SNAPSHOT_KEY]: JSON.stringify({ schemaVersion: 0 }) });
    expect((await loadOrSeedBank(outdated, { now: NOW })).user.is_demo).toBe(true);
  });

  it('resets to a fresh seed', async () => {
    const store = createMemoryStore();
    const bank = await loadOrSeedBank(store, { now: NOW });
    bank.user.preferred_name = 'Changed';
    await saveBank(store, bank);
    expect((await resetBank(store, { now: NOW })).user.preferred_name).toBe('Tolu');
  });
});
