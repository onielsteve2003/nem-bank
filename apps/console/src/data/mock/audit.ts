import type { OperationId, Schema, Staff } from '@nem/contracts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import { lagosDate } from '@/lib/dates';

import { problem } from '../errors';
import type { Handlers } from './handlers';
import { paginate } from './paging';
import { newId, type MockState } from './state';

// The tamper-evident audit log (ADM-9). Each entry's hash covers the previous entry's
// hash and the entry itself, so changing or deleting any entry breaks every hash after
// it. Same scheme the Go audit package will use: SHA-256 over prev_hash + canonical JSON.

export type AuditEntry = Schema<'AuditEntry'>;
type Actor = AuditEntry['actor'];

export const GENESIS_HASH = '0'.repeat(64);

/** JSON with sorted keys, so the same entry always hashes the same way. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashEntry(entry: Omit<AuditEntry, 'hash'>): string {
  return bytesToHex(sha256(utf8ToBytes(entry.prev_hash + canonical(entry))));
}

export interface AuditInput {
  actor: Actor;
  action: string;
  resource: AuditEntry['resource'];
  metadata?: Record<string, unknown>;
  at?: string;
}

export function appendAudit(log: AuditEntry[], input: AuditInput, nowMs: number): AuditEntry {
  const prev = log.at(-1);
  const unsigned: Omit<AuditEntry, 'hash'> = {
    seq: (prev?.seq ?? 0) + 1,
    id: newId(),
    at: input.at ?? new Date(nowMs).toISOString(),
    actor: input.actor,
    action: input.action,
    resource: input.resource,
    metadata: input.metadata ?? {},
    ip: null,
    prev_hash: prev?.hash ?? GENESIS_HASH,
  };
  const entry = { ...unsigned, hash: hashEntry(unsigned) };
  log.push(entry);
  return entry;
}

/** Recomputes every hash from `fromSeq` to `toSeq` and returns the first that doesn't match. */
export function verifyChain(log: readonly AuditEntry[], fromSeq = 1, toSeq = log.length) {
  let firstBroken: number | null = null;
  for (let seq = fromSeq; seq <= toSeq; seq++) {
    const { hash, ...rest } = log[seq - 1]!;
    const expectedPrev = seq === 1 ? GENESIS_HASH : log[seq - 2]!.hash;
    if (rest.seq !== seq || rest.prev_hash !== expectedPrev || hashEntry(rest) !== hash) {
      firstBroken = seq;
      break;
    }
  }
  return { firstBroken, checked: (firstBroken ?? toSeq + 1) - fromSeq };
}

/** Demo only: what an insider editing the table directly would do. Returns the seq changed. */
export function tamperAudit(state: MockState): number {
  const target = state.audit.find((e) => e.action === 'kyc.resubmit') ?? state.audit[0]!;
  target.metadata = { ...target.metadata, decision: 'approve' };
  return target.seq;
}

type AuditRule = {
  action: string | ((body: Record<string, unknown>) => string);
  resource: string;
};

/**
 * Staff actions the log records, the way the API's audit middleware does after a
 * successful write. Reads are not logged; metadata carries IDs and outcomes, never PII.
 * approveRequest logs itself, so the approval comes before the change it applies.
 */
const AUDITED: Partial<Record<OperationId, AuditRule>> = {
  staffVerifyTotp: { action: 'staff.login', resource: 'staff' },
  staffLogout: { action: 'staff.logout', resource: 'staff' },
  addCustomerNote: { action: 'customer.note', resource: 'customer' },
  freezeCustomer: { action: 'customer.freeze', resource: 'customer' },
  requestCustomerUnfreeze: { action: 'customer.unfreeze.request', resource: 'customer' },
  decideKycReview: { action: (b) => `kyc.${String(b.decision)}`, resource: 'kyc_submission' },
  assignFraudCase: { action: 'fraud.assign', resource: 'fraud_case' },
  decideFraudCase: { action: (b) => `fraud.${String(b.decision)}`, resource: 'fraud_case' },
  decideDispute: { action: (b) => `dispute.${String(b.outcome)}`, resource: 'dispute' },
  sendAgentMessage: { action: 'support.message', resource: 'conversation' },
  resolveConversation: { action: 'support.resolve', resource: 'conversation' },
  requestConfigChange: { action: 'config.change.request', resource: 'approval' },
  updateFeatureFlag: {
    action: (b) => `feature_flag.${b.enabled ? 'enable' : 'disable'}`,
    resource: 'feature_flag',
  },
  rejectRequest: { action: 'approval.reject', resource: 'approval' },
};

/** Body fields safe to keep: outcomes and section names, never free text. */
const SAFE_FIELDS = ['decision', 'outcome', 'label', 'enabled', 'section'] as const;

type CallShape = { path?: Record<string, string>; body?: Record<string, unknown> };

export function recordStaffAction(
  state: MockState,
  operationId: OperationId,
  input: unknown,
  result: unknown,
  staff: Staff | null,
) {
  const rule = AUDITED[operationId];
  if (!rule) return;
  const { path, body = {} } = (input ?? {}) as CallShape;
  const out = (result ?? {}) as Record<string, unknown>;
  // Login has no session yet: the actor is the staff member it signed in.
  const who = staff ?? (out.staff as Staff | undefined) ?? null;
  const metadata: Record<string, unknown> = {};
  for (const field of SAFE_FIELDS) {
    if (typeof body[field] === 'string' || typeof body[field] === 'boolean') {
      metadata[field] = body[field];
    }
  }
  if (typeof out.action === 'string' && 'maker' in out) {
    metadata.approval_action = out.action;
    metadata.approval_id = out.id;
  }
  const resourceId =
    (path && Object.values(path)[0]) ??
    (typeof out.id === 'string' ? out.id : undefined) ??
    who?.id ??
    'unknown';
  appendAudit(
    state.audit,
    {
      actor: { type: 'staff', id: who?.id ?? null, name: who?.name ?? null },
      action: typeof rule.action === 'function' ? rule.action(body) : rule.action,
      resource: { type: rule.resource, id: resourceId },
      metadata,
    },
    state.now(),
  );
}

export const auditHandlers: Handlers = {
  listAuditLog: ({ query } = {}, { state }) => {
    const action = query?.action?.trim();
    const rows = state.audit
      .filter(
        (e) =>
          (!query?.actor_id || e.actor.id === query.actor_id) &&
          // A prefix: "customer" finds customer.freeze, customer.note and so on.
          (!action || e.action === action || e.action.startsWith(`${action}.`)) &&
          (!query?.resource_id || e.resource.id === query.resource_id.trim()) &&
          (!query?.from || lagosDate(Date.parse(e.at)) >= query.from) &&
          (!query?.to || lagosDate(Date.parse(e.at)) <= query.to),
      )
      .reverse();
    return paginate(structuredClone(rows), query?.cursor, query?.limit);
  },

  verifyAuditLog: ({ body }, { state }) => {
    const head = state.audit.length;
    const from = body?.from_seq ?? 1;
    const to = Math.min(body?.to_seq ?? head, head);
    if (from > to) {
      throw problem(422, 'validation_failed', 'Choose a range that exists', {
        errors: [{ field: '/from_seq', code: 'range', message: `Use 1 to ${head}.` }],
      });
    }
    const { firstBroken, checked } = verifyChain(state.audit, from, to);
    return {
      valid: firstBroken === null,
      checked,
      first_broken_seq: firstBroken,
      head_seq: head,
      head_hash: state.audit.at(-1)?.hash ?? GENESIS_HASH,
      verified_at: new Date(state.now()).toISOString(),
    };
  },
};
