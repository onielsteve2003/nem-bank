import type { RealtimeEvent, RealtimeEventOf, RealtimeEventType, Schema } from '@nem/contracts';
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useRealtime, type RealtimeSource } from '@/data';

import { queryKeys } from './keys';

// Realtime events keep the cache current (architecture §7): small events patch
// cached data in place so balances move without a refetch; everything else
// marks the affected queries stale.

type Handler<T extends RealtimeEventType> = (
  client: QueryClient,
  event: RealtimeEventOf<T>,
) => QueryKey[];

const HANDLERS: { [T in RealtimeEventType]: Handler<T> } = {
  'account.balance_updated': (client, { data }) => {
    const patch = (a: Schema<'Account'>) =>
      a.id === data.account_id
        ? { ...a, ledger_balance: data.ledger_balance, available_balance: data.available_balance }
        : a;
    client.setQueriesData<Schema<'AccountList'>>(
      { queryKey: queryKeys.method('accounts', 'list') },
      (list) => (list ? { ...list, data: list.data.map(patch) } : list),
    );
    client.setQueriesData<Schema<'Account'>>(
      { queryKey: queryKeys.method('accounts', 'get') },
      (a) => (a ? patch(a) : a),
    );
    return [queryKeys.method('accounts', 'listHolds'), ['savings', 'getSummary']];
  },
  'transaction.created': () => [
    ['transactions'],
    ['insights'],
    ['cards', 'listTransactions'],
    ['family', 'listActivity'],
  ],
  'transfer.updated': (client, { data }) => {
    client.setQueryData(queryKeys.op('transfers', 'get', { path: { transfer_id: data.id } }), data);
    return [queryKeys.method('transfers', 'list'), ['transactions']];
  },
  'money_request.received': () => [['moneyRequests']],
  'card.authorization': () => [['cards'], ['transactions']],
  'fx.alert_triggered': () => [queryKeys.method('fx', 'listAlerts')],
  'kyc.updated': () => [
    ['kyc'],
    queryKeys.method('users', 'getMe'),
    ['accounts'],
    ['security', 'getCheckup'],
  ],
  'statement.ready': (client, { data }) => {
    client.setQueryData(
      queryKeys.op('statements', 'get', { path: { statement_id: data.id } }),
      data,
    );
    return [queryKeys.method('statements', 'list')];
  },
  'ajo.updated': (client, { data }) => {
    client.setQueryData(queryKeys.op('ajo', 'getGroup', { path: { group_id: data.id } }), data);
    return [queryKeys.method('ajo', 'listGroups'), queryKeys.method('ajo', 'listCycles')];
  },
  'family.approval_requested': () => [queryKeys.method('family', 'listApprovals')],
  'dispute.updated': (client, { data }) => {
    client.setQueryData(queryKeys.op('disputes', 'get', { path: { dispute_id: data.id } }), data);
    return [queryKeys.method('disputes', 'list'), queryKeys.method('transactions', 'get')];
  },
  'support.message': () => [['support']],
  // Typing indicators are shown from the event itself and never cached.
  'support.typing': () => [],
  'notification.created': () => [['notifications']],
  'security.panic_changed': (client, { data }) => {
    client.setQueryData(queryKeys.op('security', 'getPanic'), data);
    return [['cards'], queryKeys.method('security', 'getCheckup')];
  },
  'session.revoked': () => [queryKeys.method('security', 'listSessions'), ['devices']],
};

/** Applies one event to the cache. Exported for tests and the WebSocket client. */
export function applyRealtimeEvent(client: QueryClient, event: RealtimeEvent): void {
  const handler = HANDLERS[event.type] as Handler<typeof event.type>;
  for (const queryKey of handler(client, event as never)) {
    void client.invalidateQueries({ queryKey });
  }
}

/**
 * Connects realtime to the cache: every event is applied, and after a dropped
 * connection everything is refetched, because events may have been missed.
 */
export function connectRealtime(client: QueryClient, realtime: RealtimeSource): () => void {
  let wasClosed = false;
  const stopEvents = realtime.subscribe((event) => applyRealtimeEvent(client, event));
  const stopStatus = realtime.onStatus((status) => {
    if (status === 'closed') wasClosed = true;
    if (status === 'open' && wasClosed) {
      wasClosed = false;
      void client.invalidateQueries();
    }
  });
  return () => {
    stopEvents();
    stopStatus();
  };
}

export function useRealtimeSync(): void {
  const client = useQueryClient();
  const realtime = useRealtime();
  useEffect(() => connectRealtime(client, realtime), [client, realtime]);
}
