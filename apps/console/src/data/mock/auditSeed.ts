import type { Schema } from '@nem/contracts';

import { appendAudit, type AuditEntry, type AuditInput } from './audit';
import { customerId } from './customerSeed';
import { submissionId } from './kycSeed';

// The last few days of back-office history, so the audit log and the approvals inbox
// open with something to look at. Every entry goes through appendAudit, so the seeded
// chain verifies like any other.

type Approval = Schema<'ApprovalRequest'>;

const IFEOMA = { id: '01900000-0000-7000-8000-00000000a001', name: 'Ifeoma Adeyemi' };
const AISHA = { id: '01900000-0000-7000-8000-00000000a002', name: 'Aisha Bello' };
const TUNDE = { id: '01900000-0000-7000-8000-00000000a003', name: 'Tunde Okafor' };

const staff = (s: { id: string; name: string }) => ({ type: 'staff' as const, ...s });
const SYSTEM = { type: 'system' as const, id: null, name: 'Nem Bank' };
const NGOZI = customerId(5);

const ID = {
  feesV7: '01900000-0000-7000-8000-0000000f0001',
  spreadRejected: '01900000-0000-7000-8000-0000000f0002',
  coolingOff: '01900000-0000-7000-8000-0000000f0003',
};

const HISTORY: AuditInput[] = [
  {
    at: '2026-10-30T08:02:00Z',
    actor: staff(IFEOMA),
    action: 'staff.login',
    resource: { type: 'staff', id: IFEOMA.id },
  },
  {
    at: '2026-10-30T08:40:00Z',
    actor: staff(TUNDE),
    action: 'staff.login',
    resource: { type: 'staff', id: TUNDE.id },
  },
  {
    at: '2026-10-30T09:05:00Z',
    actor: staff(TUNDE),
    action: 'config.change.request',
    resource: { type: 'approval', id: ID.feesV7 },
    metadata: { section: 'fees', approval_action: 'config_change', approval_id: ID.feesV7 },
  },
  {
    at: '2026-10-30T10:00:00Z',
    actor: staff(IFEOMA),
    action: 'approval.approve',
    resource: { type: 'approval', id: ID.feesV7 },
    metadata: { approval_action: 'config_change', approval_id: ID.feesV7 },
  },
  {
    at: '2026-10-30T10:00:00Z',
    actor: SYSTEM,
    action: 'config.change.apply',
    resource: { type: 'config', id: 'fees' },
    metadata: { version: 7 },
  },
  {
    at: '2026-10-31T07:55:00Z',
    actor: staff(AISHA),
    action: 'staff.login',
    resource: { type: 'staff', id: AISHA.id },
  },
  {
    at: '2026-10-31T08:20:00Z',
    actor: staff(AISHA),
    action: 'kyc.approve',
    resource: { type: 'kyc_submission', id: submissionId(1) },
    metadata: { decision: 'approve' },
  },
  {
    at: '2026-10-31T09:14:00Z',
    actor: staff(AISHA),
    action: 'kyc.resubmit',
    resource: { type: 'kyc_submission', id: submissionId(2) },
    metadata: { decision: 'resubmit' },
  },
  {
    at: '2026-10-31T11:30:00Z',
    actor: staff(TUNDE),
    action: 'config.change.request',
    resource: { type: 'approval', id: ID.spreadRejected },
    metadata: {
      section: 'fx_spreads_bps',
      approval_action: 'config_change',
      approval_id: ID.spreadRejected,
    },
  },
  {
    at: '2026-10-31T13:02:00Z',
    actor: staff(AISHA),
    action: 'approval.reject',
    resource: { type: 'approval', id: ID.spreadRejected },
    metadata: { approval_action: 'config_change', approval_id: ID.spreadRejected },
  },
  {
    at: '2026-11-01T08:10:00Z',
    actor: staff(IFEOMA),
    action: 'staff.login',
    resource: { type: 'staff', id: IFEOMA.id },
  },
  {
    at: '2026-11-01T08:31:00Z',
    actor: staff(IFEOMA),
    action: 'feature_flag.enable',
    resource: { type: 'feature_flag', id: 'credit_offers' },
    metadata: { enabled: true },
  },
  {
    at: '2026-11-02T20:14:00Z',
    actor: { type: 'customer', id: NGOZI, name: null },
    action: 'security.duress_pin',
    resource: { type: 'customer', id: NGOZI },
  },
  {
    at: '2026-11-02T20:14:00Z',
    actor: SYSTEM,
    action: 'customer.freeze',
    resource: { type: 'customer', id: NGOZI },
    metadata: { trigger: 'duress_pin' },
  },
  {
    at: '2026-11-02T20:31:00Z',
    actor: staff(AISHA),
    action: 'customer.note',
    resource: { type: 'customer', id: NGOZI },
  },
  {
    at: '2026-11-03T07:48:00Z',
    actor: staff(TUNDE),
    action: 'staff.login',
    resource: { type: 'staff', id: TUNDE.id },
  },
  {
    at: '2026-11-03T08:05:00Z',
    actor: staff(TUNDE),
    action: 'config.change.request',
    resource: { type: 'approval', id: ID.coolingOff },
    metadata: {
      section: 'cooling_off',
      approval_action: 'config_change',
      approval_id: ID.coolingOff,
    },
  },
];

export function seedAudit(): AuditEntry[] {
  const log: AuditEntry[] = [];
  for (const input of HISTORY) appendAudit(log, input, Date.parse(input.at!));
  return log;
}

const naira = (major: number) => ({ amount_minor: String(major * 100), currency: 'NGN' });

/** One change waiting for a checker, one applied, one turned down. */
export function seedApprovals(now: number): Map<string, Approval> {
  const approvals: Approval[] = [
    {
      id: ID.coolingOff,
      action: 'config_change',
      status: 'pending',
      maker: TUNDE,
      checker: null,
      reason: 'Scam reports doubled last week; a longer pause on new payees gives customers time.',
      summary: 'Change new-beneficiary cooling-off (config v7)',
      before: {
        section: 'cooling_off',
        value: { new_beneficiary_threshold: naira(100_000), delay_minutes: 30 },
      },
      after: {
        section: 'cooling_off',
        value: { new_beneficiary_threshold: naira(50_000), delay_minutes: 60 },
      },
      rejection_reason: null,
      created_at: '2026-11-03T08:05:00Z',
      decided_at: null,
      // Always in the future, so the seeded request never expires mid-demo.
      expires_at: new Date(now + 72 * 60 * 60_000).toISOString(),
    },
    {
      id: ID.feesV7,
      action: 'config_change',
      status: 'approved',
      maker: TUNDE,
      checker: IFEOMA,
      reason: 'Align Nem to Nem transfers with the free-transfers launch.',
      summary: 'Change fees (config v6)',
      before: { section: 'fees', value: { internal_transfer: naira(10) } },
      after: { section: 'fees', value: { internal_transfer: naira(0) } },
      rejection_reason: null,
      created_at: '2026-10-30T09:05:00Z',
      decided_at: '2026-10-30T10:00:00Z',
      expires_at: '2026-11-02T09:05:00Z',
    },
    {
      id: ID.spreadRejected,
      action: 'config_change',
      status: 'rejected',
      maker: TUNDE,
      checker: AISHA,
      reason: 'Match the spread a competitor advertises.',
      summary: 'Change FX spreads (config v7)',
      before: {
        section: 'fx_spreads_bps',
        value: { 'USD-NGN': 150, 'GBP-NGN': 175, 'EUR-NGN': 175 },
      },
      after: {
        section: 'fx_spreads_bps',
        value: { 'USD-NGN': 40, 'GBP-NGN': 175, 'EUR-NGN': 175 },
      },
      rejection_reason: 'Below our hedging cost. Bring a treasury sign-off first.',
      created_at: '2026-10-31T11:30:00Z',
      decided_at: '2026-10-31T13:02:00Z',
      expires_at: '2026-11-03T11:30:00Z',
    },
  ];
  return new Map(approvals.map((a) => [a.id, a]));
}
