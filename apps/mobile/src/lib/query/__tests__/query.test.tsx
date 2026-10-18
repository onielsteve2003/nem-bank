import type { RealtimeEvent, Schema } from '@nem/contracts';
import { QueryClient, type Query } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import {
  createEmitter,
  problem,
  repositoriesFromDispatcher,
  RepositoryProvider,
  type Call,
  type RealtimeSource,
  type RealtimeStatus,
} from '@/data';
import { createMockBank } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';

import {
  applyRealtimeEvent,
  connectRealtime,
  createQueryClient,
  queryKeys,
  QueryProvider,
  retryDelay,
  shouldPersistQuery,
  shouldRetryQuery,
  useMoneyMutation,
  useRepoQuery,
} from '../index';

const naira = (major: number) => ({ amount_minor: String(major * 100), currency: 'NGN' as const });

function wrapperFor(
  repositories: ReturnType<typeof repositoriesFromDispatcher>,
  client: QueryClient,
  realtime?: RealtimeSource,
) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <RepositoryProvider repositories={repositories} realtime={realtime}>
        <QueryProvider client={client}>{children}</QueryProvider>
      </RepositoryProvider>
    );
  };
}

describe('query keys', () => {
  it('nest so a domain or method prefix covers every input', () => {
    const key = queryKeys.op('transfers', 'get', { path: { transfer_id: 't1' } });
    expect(key.slice(0, 2)).toEqual(queryKeys.method('transfers', 'get'));
    expect(key.slice(0, 1)).toEqual(queryKeys.domain('transfers'));
    expect(queryKeys.op('accounts', 'list')).toEqual(queryKeys.op('accounts', 'list', undefined));
  });
});

describe('retry rules', () => {
  it('retries reads twice on transient failures only', () => {
    const outage = problem(503, 'service_unavailable', 'Down');
    expect(shouldRetryQuery(0, outage)).toBe(true);
    expect(shouldRetryQuery(2, outage)).toBe(false);
    expect(shouldRetryQuery(0, problem(422, 'insufficient_funds', 'No'))).toBe(false);
    expect(shouldRetryQuery(0, new TypeError('Network request failed'))).toBe(true);
  });

  it('backs off exponentially and honours retry_at', () => {
    expect(retryDelay(0, new Error('x'))).toBe(500);
    expect(retryDelay(10, new Error('x'))).toBe(8_000);
    const retryAt = new Date(Date.now() + 3_000).toISOString();
    expect(
      retryDelay(0, problem(429, 'rate_limited', 'Slow down', { retry_at: retryAt })),
    ).toBeGreaterThan(2_000);
  });

  it('never retries or queues mutations', () => {
    const defaults = createQueryClient().getDefaultOptions().mutations!;
    expect(defaults.retry).toBe(false);
    expect(defaults.networkMode).toBe('always');
  });

  it('keeps sessions, revealed card data and quotes out of the persisted cache', () => {
    const query = (queryKey: unknown[]) =>
      ({ queryKey, state: { status: 'success' } }) as unknown as Query;
    expect(shouldPersistQuery(query(['accounts', 'list', null]))).toBe(true);
    expect(shouldPersistQuery(query(['auth', 'refresh', null]))).toBe(false);
    expect(shouldPersistQuery(query(['cards', 'reveal', { path: { card_id: 'c' } }]))).toBe(false);
    expect(shouldPersistQuery(query(['fx', 'createQuote', null]))).toBe(false);
  });
});

describe('useMoneyMutation', () => {
  it('reuses the idempotency key when the same request is retried, and makes a new one otherwise', async () => {
    const calls: Call[] = [];
    let fail = true;
    const repositories = repositoriesFromDispatcher(async (call) => {
      calls.push(call);
      if (fail) {
        fail = false;
        throw problem(504, 'gateway_timeout', 'Timed out');
      }
      return { id: 'transfer-1' };
    });
    const client = createQueryClient();
    const { result } = await renderHook(() => useMoneyMutation('transfers', 'create'), {
      wrapper: wrapperFor(repositories, client),
    });
    const body = {
      source_account_id: 'a1',
      destination: { kind: 'nem' as const, account_number: '0420270000' },
      amount: naira(1_000),
      save_beneficiary: false,
    };
    await act(async () => {
      await result.current.mutateAsync({ body }).catch(() => undefined);
    });
    // It did not retry on its own.
    expect(calls).toHaveLength(1);
    await act(async () => {
      await result.current.mutateAsync({ body });
    });
    const keyOf = (c: Call) => (c.input as { idempotencyKey: string }).idempotencyKey;
    expect(keyOf(calls[1]!)).toBe(keyOf(calls[0]!));

    await act(async () => {
      await result.current.mutateAsync({ body });
    });
    expect(keyOf(calls[2]!)).not.toBe(keyOf(calls[0]!));
    await act(async () => {
      await result.current.mutateAsync({ body: { ...body, amount: naira(2_000) } });
    });
    expect(keyOf(calls[3]!)).not.toBe(keyOf(calls[2]!));
  });
});

describe('realtime cache sync', () => {
  const account = {
    id: 'a1',
    available_balance: naira(10),
    ledger_balance: naira(10),
  } as Schema<'Account'>;

  it('patches balances in place and refreshes what an event affects', () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.op('accounts', 'list'), { data: [account] });
    client.setQueryData(queryKeys.op('transactions', 'list'), {
      data: [],
      page: { next_cursor: null },
    });
    const event = (e: Partial<RealtimeEvent>) =>
      ({ id: 'e', occurred_at: '2026-10-17T12:00:00Z', ...e }) as RealtimeEvent;

    applyRealtimeEvent(
      client,
      event({
        type: 'account.balance_updated',
        data: { account_id: 'a1', ledger_balance: naira(99), available_balance: naira(90) },
      }),
    );
    expect(
      client.getQueryData<Schema<'AccountList'>>(queryKeys.op('accounts', 'list'))!.data[0]!
        .available_balance,
    ).toEqual(naira(90));

    applyRealtimeEvent(
      client,
      event({ type: 'transaction.created', data: {} as Schema<'Transaction'> }),
    );
    expect(client.getQueryState(queryKeys.op('transactions', 'list'))!.isInvalidated).toBe(true);

    const transfer = { id: 't1', status: 'completed' } as Schema<'Transfer'>;
    applyRealtimeEvent(client, event({ type: 'transfer.updated', data: transfer }));
    expect(
      client.getQueryData(queryKeys.op('transfers', 'get', { path: { transfer_id: 't1' } })),
    ).toEqual(transfer);
  });

  it('refetches everything after the connection drops and comes back', () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.op('users', 'getMe'), { id: 'u1' });
    const statuses = createEmitter<RealtimeStatus>();
    const source: RealtimeSource = {
      subscribe: () => () => undefined,
      status: () => 'open',
      onStatus: statuses.subscribe,
    };
    const stop = connectRealtime(client, source);
    statuses.emit('closed');
    statuses.emit('open');
    stop();
    expect(client.getQueryState(queryKeys.op('users', 'getMe'))!.isInvalidated).toBe(true);
  });
});

describe('with the mock bank', () => {
  it('reads through repositories and moves the cached balance when money is sent', async () => {
    const bank = createMockBank({
      store: createMemoryStore(),
      clock: () => new Date('2026-10-17T12:00:00Z'),
      simulation: { latency: 'off' },
      pulseMs: 60_000,
    });
    const client = createQueryClient();
    const wrapper = wrapperFor(bank.repositories, client, bank.realtime);
    const { result, unmount } = await renderHook(() => useRepoQuery('accounts', 'list'), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const ngn = result.current.data!.data.find((a) => a.currency === 'NGN')!;
    const before = BigInt(ngn.available_balance.amount_minor);

    await bank.repositories.transfers.create({
      body: {
        source_account_id: ngn.id,
        destination: { kind: 'nem', account_number: '0420270000' },
        amount: naira(1_000),
        save_beneficiary: false,
      },
      idempotencyKey: 'q-1',
    });
    await waitFor(() => {
      const after = result.current.data!.data.find((a) => a.id === ngn.id)!;
      expect(BigInt(after.available_balance.amount_minor)).toBe(before - 100_000n);
    });
    await unmount();
    client.clear();
  });
});
