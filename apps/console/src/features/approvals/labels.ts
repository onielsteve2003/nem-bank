import type { Tone } from '@/components/Badge';

import type { ApprovalRequest, ApprovalStatus } from './useApprovals';

export const FILTERS: readonly { value: ApprovalStatus; label: string }[] = [
  { value: 'pending', label: 'Waiting' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'expired', label: 'Expired' },
];

export const STATUS: Readonly<Record<ApprovalStatus, [label: string, tone: Tone]>> = {
  pending: ['Waiting for a checker', 'warning'],
  approved: ['Approved', 'success'],
  rejected: ['Rejected', 'danger'],
  expired: ['Expired', 'neutral'],
};

export const ACTIONS: Readonly<Record<ApprovalRequest['action'], string>> = {
  customer_unfreeze: 'Unfreeze',
  limit_override: 'Limit override',
  ledger_adjustment: 'Ledger adjustment',
  config_change: 'Configuration',
  dispute_refund: 'Dispute refund',
};
