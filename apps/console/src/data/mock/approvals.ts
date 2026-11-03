import type { Schema } from '@nem/contracts';

import { problem } from '../errors';
import { appendAudit } from './audit';
import type { BankConfig } from './configSeed';
import { findCustomer, setFrozen } from './customers';
import { refundDispute } from './disputes';
import type { Handlers } from './handlers';
import { paginate, requireReason, staffRef } from './paging';
import { newId, type MockState } from './state';

type Approval = Schema<'ApprovalRequest'>;
type StaffRef = Schema<'StaffRef'>;

const SYSTEM = { type: 'system' as const, id: null, name: 'Nem Bank' };

/** A pending request past its deadline can no longer be approved (MakerCheckerStatus). */
function expireStale(state: MockState) {
  const now = state.now();
  for (const a of state.approvals.values()) {
    if (a.status === 'pending' && Date.parse(a.expires_at) <= now) a.status = 'expired';
  }
}

function findApproval(state: MockState, id: string): Approval {
  expireStale(state);
  const found = state.approvals.get(id);
  if (!found) throw problem(404, 'not_found', 'No approval request with that ID');
  return found;
}

function requirePending(a: Approval) {
  if (a.status === 'expired') {
    throw problem(409, 'approval_expired', 'This request expired', {
      detail: 'Ask the maker to send it again if it is still needed.',
    });
  }
  if (a.status !== 'pending')
    throw problem(409, 'conflict', `This request was already ${a.status}`);
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Carries out the change the maker proposed, as the checker's approval does in the API. */
function apply(state: MockState, a: Approval, checker: StaffRef, at: string) {
  const after = a.after ?? {};
  switch (a.action) {
    case 'customer_unfreeze': {
      const record = findCustomer(state, String(after.user_id));
      setFrozen(record, false);
      record.view.notes = [
        {
          id: newId(),
          author: checker,
          body: `Unfroze the account, approving ${a.maker.name}'s request: ${a.reason}`,
          created_at: at,
        },
        ...record.view.notes,
      ];
      return { type: 'customer', id: record.view.customer.user_id, action: 'customer.unfreeze' };
    }
    case 'config_change': {
      const section = String(after.section) as keyof BankConfig;
      // Someone changed this section since the request was made: the checker's diff is stale.
      if (!sameJson(state.config[section], a.before?.value)) {
        throw problem(409, 'stale_config', 'This section changed since the request was made', {
          detail: 'Reject this request and ask the maker to propose the change again.',
        });
      }
      Object.assign(state.config, {
        [section]: structuredClone(after.value),
        version: state.config.version + 1,
        updated_at: at,
      });
      return { type: 'config', id: section, action: 'config.change.apply' };
    }
    case 'dispute_refund': {
      const disputeId = String(after.dispute_id);
      refundDispute(state, disputeId, after.refund as Schema<'Money'>, a.reason, at);
      return { type: 'dispute', id: disputeId, action: 'dispute.refund.apply' };
    }
    case 'limit_override':
    case 'ledger_adjustment':
      throw problem(501, 'not_implemented', 'Not available in the demo yet', {
        detail: `Applying a ${a.action} has no mock yet.`,
      });
  }
}

export const approvalHandlers: Handlers = {
  listApprovalRequests: ({ query } = {}, { state }) => {
    expireStale(state);
    const rows = [...state.approvals.values()]
      .filter((a) => a.status === (query?.status ?? 'pending'))
      // Pending: the oldest has waited longest. Decided: the latest decision first.
      .sort((a, b) =>
        a.status === 'pending'
          ? a.created_at.localeCompare(b.created_at)
          : (b.decided_at ?? b.created_at).localeCompare(a.decided_at ?? a.created_at),
      );
    return paginate(structuredClone(rows), query?.cursor, query?.limit);
  },

  getApprovalRequest: ({ path }, { state }) =>
    structuredClone(findApproval(state, path.approval_id)),

  approveRequest: ({ path, idempotencyKey }, { state, staff }) => {
    const replay = state.idempotency.get(idempotencyKey);
    if (replay) return structuredClone(replay as Approval);

    const a = findApproval(state, path.approval_id);
    const checker = staffRef(staff);
    if (a.maker.id === checker.id) {
      throw problem(403, 'same_staff', 'Someone else has to approve this', {
        detail: 'You made this request. A second staff member must check it (maker-checker).',
      });
    }
    requirePending(a);

    const at = new Date(state.now()).toISOString();
    const effect = apply(state, a, checker, at);
    Object.assign(a, { status: 'approved', checker, decided_at: at });
    // Logged here rather than by the dispatcher: the approval, then the change it applied.
    appendAudit(
      state.audit,
      {
        actor: { type: 'staff', ...checker },
        action: 'approval.approve',
        resource: { type: 'approval', id: a.id },
        metadata: { approval_action: a.action, approval_id: a.id },
      },
      state.now(),
    );
    appendAudit(
      state.audit,
      {
        actor: SYSTEM,
        action: effect.action,
        resource: { type: effect.type, id: effect.id },
        metadata: { approval_id: a.id },
      },
      state.now(),
    );
    state.idempotency.set(idempotencyKey, structuredClone(a));
    return structuredClone(a);
  },

  rejectRequest: ({ path, body }, { state, staff }) => {
    const a = findApproval(state, path.approval_id);
    const checker = staffRef(staff);
    const reason = requireReason(body.reason);
    if (a.maker.id === checker.id) {
      throw problem(403, 'same_staff', 'Someone else has to decide this', {
        detail: 'You made this request. Withdrawing it is not part of the demo.',
      });
    }
    requirePending(a);
    Object.assign(a, {
      status: 'rejected',
      checker,
      rejection_reason: reason,
      decided_at: new Date(state.now()).toISOString(),
    });
    // A refund waiting on a checker goes back to the queue for another decision.
    if (a.action === 'dispute_refund') {
      const d = state.disputes.get(String(a.after?.dispute_id));
      if (d?.dispute.status === 'under_review') {
        d.dispute.timeline.push({
          status: 'under_review',
          label: 'Refund not approved',
          at: a.decided_at!,
          detail: reason,
        });
      }
    }
    return structuredClone(a);
  },
};
