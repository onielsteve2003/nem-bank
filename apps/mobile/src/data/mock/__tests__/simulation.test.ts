import type { RealtimeEvent } from '@nem/contracts';

import { isApiError } from '../../errors';
import type { RealtimeStatus } from '../../realtime';
import { createMockBank, type MockOptions } from '../index';
import { createMemoryStore } from '../persistence/types';
import { latencyFor, sleep } from '../simulation';

const START = new Date('2026-10-17T12:00:00.000Z');
const naira = (major: number) => ({ amount_minor: String(major * 100), currency: 'NGN' as const });

function setup(options: MockOptions = {}) {
  let now = START;
  const handle = createMockBank({
    store: createMemoryStore(),
    clock: () => now,
    simulation: { latency: 'off' },
    pulseMs: 60_000,
    ...options,
  });
  return { ...handle, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

async function ngn(handle: ReturnType<typeof setup>) {
  const { data } = await handle.repositories.accounts.list();
  return data.find((a) => a.currency === 'NGN')!;
}

const nemTransfer = (sourceId: string, major = 1_000) => ({
  source_account_id: sourceId,
  destination: { kind: 'nem' as const, account_number: '0420270000' },
  amount: naira(major),
  save_beneficiary: false,
});

describe('latency', () => {
  it('stays inside each profile, with writes slower than reads', () => {
    expect(latencyFor('off', true, () => 0.5)).toBe(0);
    expect(latencyFor('realistic', false, () => 0)).toBe(180);
    expect(latencyFor('realistic', true, () => 1)).toBe(1_300);
    expect(latencyFor('slow', false, () => 0.5)).toBeGreaterThan(latencyFor('fast', true, () => 1));
  });

  it('cancels a delayed call as soon as the caller aborts', async () => {
    const controller = new AbortController();
    const waiting = sleep(10_000, controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(waiting).rejects.toThrow('cancelled');
  });
});

describe('network simulation', () => {
  it('fails every call while offline and changes nothing', async () => {
    const bank = setup();
    const account = await ngn(bank);
    bank.simulation.set({ offline: true });
    const error = await bank.repositories.transfers
      .create({ body: nemTransfer(account.id), idempotencyKey: 'off-1' })
      .catch((e: unknown) => e);
    expect(isApiError(error, 'offline')).toBe(true);
    bank.simulation.set({ offline: false });
    expect((await ngn(bank)).available_balance).toEqual(account.available_balance);
  });

  it('injects outages before the call runs, so nothing is half done', async () => {
    const bank = setup({ random: () => 0 });
    const account = await ngn(bank);
    bank.simulation.set({ errorRate: 1 });
    await expect(
      bank.repositories.transfers.create({
        body: nemTransfer(account.id),
        idempotencyKey: 'err-1',
      }),
    ).rejects.toMatchObject({ code: 'service_unavailable' });
    bank.simulation.set({ errorRate: 0 });
    expect((await ngn(bank)).available_balance).toEqual(account.available_balance);
  });

  it('can lose the response after a payment, and a retry with the same key does not pay twice', async () => {
    const bank = setup({ random: () => 0 });
    const account = await ngn(bank);
    const before = BigInt(account.available_balance.amount_minor);
    bank.simulation.set({ failAfterCommit: true });
    const body = nemTransfer(account.id, 2_500);
    await expect(
      bank.repositories.transfers.create({ body, idempotencyKey: 'lost-1' }),
    ).rejects.toMatchObject({ code: 'gateway_timeout' });
    bank.simulation.set({ failAfterCommit: false });
    const retry = await bank.repositories.transfers.create({ body, idempotencyKey: 'lost-1' });
    expect(retry.status).toBe('completed');
    expect(BigInt((await ngn(bank)).available_balance.amount_minor)).toBe(before - 250_000n);
    expect(
      (await bank.repositories.transfers.list()).data.filter((t) => t.id === retry.id),
    ).toHaveLength(1);
  });

  it('rejects an invalid error rate', () => {
    expect(() => setup().simulation.set({ errorRate: 2 })).toThrow(RangeError);
  });
});

describe('realtime emitter', () => {
  it('opens when someone listens and closes when they leave or the network drops', async () => {
    const bank = setup();
    const statuses: RealtimeStatus[] = [];
    bank.realtime.onStatus((s) => statuses.push(s));
    const stop = bank.realtime.subscribe(() => undefined);
    await bank.repositories.users.getMe();
    expect(bank.realtime.status()).toBe('open');
    bank.simulation.set({ offline: true });
    expect(bank.realtime.status()).toBe('closed');
    bank.simulation.set({ offline: false });
    await bank.repositories.users.getMe().catch(() => undefined);
    await Promise.resolve();
    expect(bank.realtime.status()).toBe('open');
    stop();
    expect(statuses).toEqual(['connecting', 'open', 'closed', 'connecting', 'open', 'closed']);
  });

  it('publishes the new transaction and balances for an instant transfer', async () => {
    const bank = setup();
    const events: RealtimeEvent[] = [];
    const stop = bank.realtime.subscribe((e) => events.push(e));
    const account = await ngn(bank);
    const transfer = await bank.repositories.transfers.create({
      body: nemTransfer(account.id),
      idempotencyKey: 'rt-1',
    });
    stop();
    const types = events.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'transaction.created',
        'transfer.updated',
        'account.balance_updated',
      ]),
    );
    const balance = events.find((e) => e.type === 'account.balance_updated');
    expect(balance?.type === 'account.balance_updated' && balance.data.account_id).toBe(account.id);
    const txn = events.find((e) => e.type === 'transaction.created');
    expect(txn?.type === 'transaction.created' && txn.data.transfer_id).toBe(transfer.id);
  });

  it('pushes the status change when the partner bank answers, with no call from the app', async () => {
    const bank = setup();
    const account = await ngn(bank);
    const beneficiary = (await bank.repositories.beneficiaries.list()).data.find(
      (b) => b.kind === 'bank',
    )!;
    const sent = await bank.repositories.transfers.create({
      body: {
        source_account_id: account.id,
        destination: { kind: 'beneficiary', beneficiary_id: beneficiary.id },
        amount: naira(3_000),
        save_beneficiary: false,
      },
      idempotencyKey: 'rt-ext',
    });
    expect(sent.status).toBe('processing');
    const stop = bank.realtime.subscribe(() => undefined);
    bank.advance(5_000);
    const events = await bank.pulse();
    stop();
    const update = events.find((e) => e.type === 'transfer.updated');
    expect(update?.type === 'transfer.updated' && update.data.status).toBe('completed');
    expect(events.some((e) => e.type === 'transaction.created')).toBe(true);
  });

  it('announces simulated incoming money from Demo Controls and ambient activity', async () => {
    const bank = setup({ random: () => 0 });
    const account = await ngn(bank);
    const events: RealtimeEvent[] = [];
    const stop = bank.realtime.subscribe((e) => events.push(e));
    await bank.repositories.demo.inboundTransfer({
      body: { account_id: account.id, amount: naira(25_000), sender_name: 'Kora Labs Ltd' },
      idempotencyKey: 'in-1',
    });
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['transaction.created', 'notification.created']),
    );

    bank.simulation.set({ ambientActivity: true });
    const ambient = await bank.pulse();
    stop();
    const created = ambient.find((e) => e.type === 'transaction.created');
    expect(created?.type === 'transaction.created' && created.data.direction).toBe('credit');
  });
});
