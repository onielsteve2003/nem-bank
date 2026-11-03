import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';

import { fromApiMoney } from '@/lib/money';

import { problem } from '../errors';
import { findCustomer } from './customers';
import { REFUND_CHECKER_THRESHOLD, isOpenDispute, type AdminDispute } from './disputeSeed';
import type { Handlers } from './handlers';
import { paginate, staffRef } from './paging';
import { newId, type MockState } from './state';

const APPROVAL_TTL_MS = 72 * 60 * 60_000;

function findDispute(state: MockState, disputeId: string): AdminDispute {
  const found = state.disputes.get(disputeId);
  if (!found) throw problem(404, 'not_found', 'No dispute with that ID');
  return found;
}

/** The customer as they are now (a freeze since the dispute shows). */
const view = (state: MockState, d: AdminDispute): AdminDispute =>
  structuredClone({ ...d, customer: findCustomer(state, d.customer.user_id).view.customer });

function invalid(field: string, title: string, message: string): never {
  throw problem(422, 'validation_failed', title, { errors: [{ field, code: 'invalid', message }] });
}

/** Posts the refund to the customer's account, the way the ledger's dispute_refund entry will. */
function postRefund(state: MockState, d: AdminDispute, refund: Schema<'Money'>, at: string) {
  const record = findCustomer(state, d.customer.user_id);
  const account = record.view.accounts.find((a) => a.id === d.transaction.account_id);
  if (account) {
    const credit = (m: Schema<'Money'>) => ({
      ...m,
      amount_minor: (BigInt(m.amount_minor) + BigInt(refund.amount_minor)).toString(),
    });
    account.ledger_balance = credit(account.ledger_balance);
    account.available_balance = credit(account.available_balance);
  }
  const refundTx: Schema<'Transaction'> = {
    id: newId(),
    account_id: d.transaction.account_id,
    type: 'dispute_refund',
    direction: 'credit',
    status: 'completed',
    amount: refund,
    fee: null,
    balance_after: account?.ledger_balance ?? null,
    narration: `Refund for ${d.dispute.case_number}`,
    reference: `NEMREF${d.dispute.case_number.slice(4)}`,
    category: 'other',
    category_source: 'rules',
    counterparty: { name: 'Nem Bank disputes' },
    transfer_id: null,
    card_id: null,
    created_at: at,
  };
  record.view.recent_transactions = [refundTx, ...record.view.recent_transactions].slice(0, 20);
}

function close(state: MockState, d: AdminDispute) {
  findCustomer(state, d.customer.user_id).view.open_cases.disputes -= 1;
}

export const disputeHandlers: Handlers = {
  listAdminDisputes: ({ query } = {}, { state }) => {
    const rows = [...state.disputes.values()]
      // No status means the work still to do.
      .filter((d) =>
        query?.status ? d.dispute.status === query.status : isOpenDispute(d.dispute.status),
      )
      // Oldest first: the longest a customer has been waiting.
      .sort((a, b) => a.dispute.created_at.localeCompare(b.dispute.created_at))
      .map((d) => view(state, d));
    return paginate(rows, query?.cursor, query?.limit);
  },

  getAdminDispute: ({ path }, { state }) => view(state, findDispute(state, path.dispute_id)),

  decideDispute: ({ path, body, idempotencyKey }, { state, staff }) => {
    // A retried decision (lost response, double click) returns the first result.
    const replay = state.idempotency.get(idempotencyKey);
    if (replay) return structuredClone(replay as AdminDispute | Schema<'ApprovalRequest'>);

    const d = findDispute(state, path.dispute_id);
    const me = staffRef(staff);
    if (!isOpenDispute(d.dispute.status)) {
      throw problem(409, 'conflict', 'This dispute is already closed');
    }
    const note = body.note.trim();
    if (note.length < 5 || note.length > 1000) {
      invalid('/note', 'Write a note of 5 to 1,000 characters', 'Use 5 to 1,000 characters.');
    }

    const at = new Date(state.now()).toISOString();
    const event = (status: string, label: string, detail: string | null = note) =>
      d.dispute.timeline.push({ status, label, at, detail });
    d.assignee = me;
    let result: AdminDispute | Schema<'ApprovalRequest'>;

    if (body.outcome === 'refund') {
      const refund = body.refund_amount;
      const disputed = d.transaction.amount;
      if (!refund) invalid('/refund_amount', 'Enter the refund amount', 'Required for a refund.');
      if (refund.currency !== disputed.currency) {
        invalid('/refund_amount', 'Refund in the currency charged', `Use ${disputed.currency}.`);
      }
      const amount = BigInt(refund.amount_minor);
      if (amount <= 0n || amount > BigInt(disputed.amount_minor)) {
        invalid(
          '/refund_amount',
          'A refund can be at most the disputed amount',
          'Above zero, up to the amount charged.',
        );
      }
      const waiting = [...state.approvals.values()].some(
        (a) =>
          a.action === 'dispute_refund' &&
          a.status === 'pending' &&
          a.after?.dispute_id === d.dispute.id,
      );
      if (waiting) {
        throw problem(409, 'approval_pending', 'A refund is already waiting for approval');
      }

      const threshold = REFUND_CHECKER_THRESHOLD[refund.currency];
      if (threshold !== undefined && amount > threshold) {
        // Large refunds move bank money, so a second person approves them (ADM-10).
        const now = state.now();
        const shown = formatMoney(fromApiMoney(refund));
        const approval: Schema<'ApprovalRequest'> = {
          id: newId(),
          action: 'dispute_refund',
          status: 'pending',
          maker: me,
          checker: null,
          reason: note,
          summary: `Refund ${shown} to ${d.customer.name} (${d.dispute.case_number})`,
          before: { dispute_id: d.dispute.id, status: d.dispute.status, refund: null },
          after: { dispute_id: d.dispute.id, status: 'resolved_refunded', refund },
          rejection_reason: null,
          created_at: at,
          decided_at: null,
          expires_at: new Date(now + APPROVAL_TTL_MS).toISOString(),
        };
        state.approvals.set(approval.id, approval);
        d.dispute.status = 'under_review';
        event('under_review', `Refund of ${shown} sent for a second approval`, null);
        result = structuredClone(approval);
      } else {
        d.dispute.status = 'resolved_refunded';
        d.dispute.refund = refund;
        d.dispute.resolution_note = note;
        d.dispute.resolved_at = at;
        event('resolved_refunded', 'Refunded');
        postRefund(state, d, refund, at);
        close(state, d);
        result = view(state, d);
      }
    } else if (body.outcome === 'decline') {
      d.dispute.status = 'resolved_declined';
      d.dispute.resolution_note = note;
      d.dispute.resolved_at = at;
      event('resolved_declined', 'Declined');
      close(state, d);
      result = view(state, d);
    } else {
      d.dispute.status = 'awaiting_customer';
      event('awaiting_customer', 'We asked the customer for more');
      result = view(state, d);
    }

    state.idempotency.set(idempotencyKey, result);
    return structuredClone(result);
  },
};
