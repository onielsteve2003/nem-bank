import type { RealtimeEvent, RealtimeEventOf, RealtimeEventType, Schema } from '@nem/contracts';

import { ajoView } from './domains/ajo';
import { midRate } from './domains/fx';
import type { MockBank } from './runtime';
import { accountView, customerTransactions, transferView } from './views';

// Realtime events for the mock bank. Rather than every use case remembering to
// publish, the bank is fingerprinted before and after each call or background
// tick, and each difference becomes the event the server's outbox would send.

export interface BankFingerprint {
  balances: Map<string, string>;
  transactions: Map<string, string>;
  transfers: Map<string, string>;
  notifications: Set<string>;
  incomingRequests: Set<string>;
  kyc: string;
  statements: Map<string, string>;
  ajo: Map<string, string>;
  approvals: Set<string>;
  disputes: Map<string, string>;
  messages: Set<string>;
  panic: boolean;
  fxAlerts: Map<string, string>;
}

const byId = <T extends { id: string }>(items: readonly T[], key: (item: T) => string) =>
  new Map(items.map((i) => [i.id, key(i)]));

export function fingerprint(bank: MockBank): BankFingerprint {
  const w = bank.world;
  return {
    balances: new Map(
      bank
        .customerAccounts()
        .map((a) => [a.id, `${a.balance.amount}|${bank.ledger.available(a.id).amount}`]),
    ),
    transactions: byId(customerTransactions(bank), (t) => t.status),
    transfers: byId(w.transfers, (t) => `${t.status}|${t.updated_at}`),
    notifications: new Set(w.notifications.map((n) => n.id)),
    incomingRequests: new Set(
      w.moneyRequests.filter((r) => r.direction === 'incoming').map((r) => r.id),
    ),
    kyc: `${bank.user.kyc_tier}|${bank.user.kyc_status}`,
    statements: byId(w.statements, (s) => s.status),
    ajo: byId(
      w.ajo,
      (g) =>
        `${g.status}|${g.current_cycle}|${bank.ledger.account(g.escrowAccountId).balance.amount}`,
    ),
    approvals: new Set(w.approvals.map((a) => a.id)),
    disputes: byId(w.disputes, (d) => d.status),
    messages: new Set(w.messages.map((m) => m.id)),
    panic: w.panic.active,
    fxAlerts: byId(w.fxAlerts, (a) => a.status),
  };
}

const changedKeys = (before: Map<string, string>, after: Map<string, string>) =>
  [...after].filter(([id, value]) => before.get(id) !== value).map(([id]) => id);
const added = (before: Set<string>, after: Set<string>) =>
  [...after].filter((id) => !before.has(id));

export function diffEvents(
  bank: MockBank,
  before: BankFingerprint,
  after: BankFingerprint,
): RealtimeEvent[] {
  const events: RealtimeEvent[] = [];
  const at = bank.nowIso();
  const push = <T extends RealtimeEventType>(type: T, data: RealtimeEventOf<T>['data']) =>
    events.push({ id: bank.id(), type, occurred_at: at, data } as RealtimeEvent);
  const w = bank.world;

  const txns = new Map(customerTransactions(bank).map((t) => [t.id, t]));
  for (const id of changedKeys(before.transactions, after.transactions).reverse()) {
    push('transaction.created', txns.get(id)!);
  }
  for (const id of changedKeys(before.transfers, after.transfers)) {
    push('transfer.updated', transferView(w.transfers.find((t) => t.id === id)!));
  }
  for (const id of changedKeys(before.balances, after.balances)) {
    const view = accountView(bank, bank.ledger.account(id));
    push('account.balance_updated', {
      account_id: id,
      ledger_balance: view.ledger_balance,
      available_balance: view.available_balance,
    });
  }
  for (const id of added(before.incomingRequests, after.incomingRequests)) {
    push(
      'money_request.received',
      w.moneyRequests.find((r) => r.id === id)!,
    );
  }
  if (before.kyc !== after.kyc) {
    push('kyc.updated', {
      tier: bank.user.kyc_tier,
      status: bank.user.kyc_status,
      submission: w.kyc.submissions.at(-1) ?? null,
    });
  }
  for (const id of changedKeys(before.statements, after.statements)) {
    const statement = w.statements.find((s) => s.id === id)!;
    if (statement.status === 'ready') push('statement.ready', statement);
  }
  for (const id of changedKeys(before.ajo, after.ajo)) {
    push(
      'ajo.updated',
      ajoView(
        bank,
        w.ajo.find((g) => g.id === id)!,
      ),
    );
  }
  for (const id of added(before.approvals, after.approvals)) {
    push(
      'family.approval_requested',
      w.approvals.find((a) => a.id === id)!,
    );
  }
  for (const id of changedKeys(before.disputes, after.disputes)) {
    push(
      'dispute.updated',
      w.disputes.find((d) => d.id === id)!,
    );
  }
  for (const id of added(before.messages, after.messages)) {
    const message = w.messages.find((m) => m.id === id)!;
    // The customer's own messages come back in the send response, not as an event.
    if (message.sender !== 'customer') push('support.message', message);
  }
  if (before.panic !== after.panic) {
    const panic: Schema<'PanicState'> = {
      active: w.panic.active,
      activated_at: w.panic.activatedAt,
      cards_frozen: w.panic.frozenCardIds.length,
      outgoing_blocked: w.panic.active,
    };
    push('security.panic_changed', panic);
  }
  for (const id of changedKeys(before.fxAlerts, after.fxAlerts)) {
    const alert = w.fxAlerts.find((a) => a.id === id)!;
    if (alert.status === 'triggered') {
      const [base] = alert.pair.split('-') as ['USD' | 'GBP' | 'EUR'];
      push('fx.alert_triggered', { alert, rate: midRate(base, bank.now().getTime()) });
    }
  }
  // Notifications last: they summarise what the events above already carried.
  for (const id of added(before.notifications, after.notifications)) {
    push(
      'notification.created',
      w.notifications.find((n) => n.id === id)!,
    );
  }
  return events;
}
