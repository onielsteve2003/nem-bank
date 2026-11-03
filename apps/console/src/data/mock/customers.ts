import type { Schema, Staff } from '@nem/contracts';

import { problem } from '../errors';
import type { Customer360, CustomerRecord } from './customerSeed';
import type { Handlers } from './handlers';
import { paginate, requireReason, staffRef } from './paging';
import { newId, type MockState } from './state';

const APPROVAL_TTL_MS = 72 * 60 * 60_000;

export function findCustomer(state: MockState, userId: string): CustomerRecord {
  const record = state.customers.get(userId);
  if (!record) throw problem(404, 'not_found', 'No customer with that ID');
  return record;
}

/** What one staff member may see: support never gets the date of birth (ADM-3). */
function viewFor(record: CustomerRecord, staff: Staff | null): Customer360 {
  const supportOnly = staff?.roles.every((r) => r === 'support') ?? true;
  return structuredClone(supportOnly ? { ...record.view, date_of_birth: null } : record.view);
}

const digits = (s: string) => s.replace(/\D/g, '');

function matches(record: CustomerRecord, q: string): boolean {
  const { customer, accounts } = record.view;
  const text = q.toLowerCase().replace(/^@/, '');
  const qDigits = digits(q);
  if (customer.name.toLowerCase().includes(text)) return true;
  if (record.email.toLowerCase().includes(text)) return true;
  if (customer.nemtag?.includes(text)) return true;
  if (qDigits.length < 4) return false;
  // Phones match with or without the +234 / leading 0.
  const local = qDigits.replace(/^(234|0)/, '');
  if (local.length >= 4 && digits(record.phone).includes(local)) return true;
  return accounts.some(
    (a) =>
      'account_number' in a.receiving_details && a.receiving_details.account_number === qDigits,
  );
}

function setFrozen(record: CustomerRecord, frozen: boolean) {
  const status = frozen ? 'frozen' : 'active';
  const view = record.view;
  view.customer.status = status;
  view.accounts = view.accounts.map((a) => ({ ...a, status }));
  view.flags = frozen
    ? [...new Set([...view.flags, 'frozen' as const])]
    : view.flags.filter((f) => f !== 'frozen');
}

export const customerHandlers: Handlers = {
  searchCustomers: ({ query }, { state }) => {
    const q = query.q.trim();
    if (q.length < 2 || q.length > 100) {
      throw problem(422, 'validation_failed', 'Type at least 2 characters', {
        errors: [{ field: '/q', code: 'length', message: 'Use 2 to 100 characters.' }],
      });
    }
    const hits = [...state.customers.values()]
      .filter((r) => matches(r, q))
      .map((r) => structuredClone(r.view.customer))
      .sort((a, b) => a.name.localeCompare(b.name));
    return paginate(hits, query.cursor, query.limit);
  },

  getCustomer360: ({ path }, { state, staff }) => viewFor(findCustomer(state, path.user_id), staff),

  addCustomerNote: ({ path, body }, { state, staff }) => {
    const record = findCustomer(state, path.user_id);
    const text = body.body.trim();
    if (text.length < 1 || text.length > 2000) {
      throw problem(422, 'validation_failed', 'A note needs 1 to 2,000 characters', {
        errors: [{ field: '/body', code: 'length', message: 'Use 1 to 2,000 characters.' }],
      });
    }
    const note: Schema<'StaffNote'> = {
      id: newId(),
      author: staffRef(staff),
      body: text,
      created_at: new Date(state.now()).toISOString(),
    };
    record.view.notes = [note, ...record.view.notes];
    return structuredClone(note);
  },

  freezeCustomer: ({ path, body }, { state, staff }) => {
    const record = findCustomer(state, path.user_id);
    const reason = requireReason(body.reason);
    if (record.view.customer.status !== 'active') {
      throw problem(409, 'conflict', `This customer is already ${record.view.customer.status}`);
    }
    // Freezing protects money, so it takes effect at once; only unfreezing needs a checker.
    setFrozen(record, true);
    record.view.notes = [
      {
        id: newId(),
        author: staffRef(staff),
        body: `Froze the account: ${reason}`,
        created_at: new Date(state.now()).toISOString(),
      },
      ...record.view.notes,
    ];
    return viewFor(record, staff);
  },

  requestCustomerUnfreeze: ({ path, body }, { state, staff }) => {
    const record = findCustomer(state, path.user_id);
    const reason = requireReason(body.reason);
    if (record.view.customer.status !== 'frozen') {
      throw problem(409, 'conflict', 'This customer is not frozen');
    }
    const waiting = [...state.approvals.values()].some(
      (a) =>
        a.action === 'customer_unfreeze' &&
        a.status === 'pending' &&
        a.after?.user_id === path.user_id,
    );
    if (waiting) {
      throw problem(409, 'approval_pending', 'An unfreeze is already waiting for approval');
    }
    const now = state.now();
    const approval: Schema<'ApprovalRequest'> = {
      id: newId(),
      action: 'customer_unfreeze',
      status: 'pending',
      maker: staffRef(staff),
      checker: null,
      reason,
      summary: `Unfreeze ${record.view.customer.name}`,
      before: { user_id: path.user_id, status: 'frozen' },
      after: { user_id: path.user_id, status: 'active' },
      rejection_reason: null,
      created_at: new Date(now).toISOString(),
      decided_at: null,
      expires_at: new Date(now + APPROVAL_TTL_MS).toISOString(),
    };
    state.approvals.set(approval.id, approval);
    return structuredClone(approval);
  },
};
