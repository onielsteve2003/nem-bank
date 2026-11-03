import type { TransferStatus } from '@nem/contracts';

const integer = new Intl.NumberFormat('en-NG');

export const formatCount = (n: number): string => integer.format(n);

/** Basis points as a percentage with two decimals: 62 → "0.62%". Exact, no floats. */
export function formatBps(bps: number): string {
  const whole = Math.floor(bps / 100);
  const fraction = String(bps % 100).padStart(2, '0');
  return `${whole}.${fraction}%`;
}

export const STATUS_LABELS: Readonly<Record<TransferStatus, string>> = {
  created: 'Created',
  risk_checked: 'Risk checked',
  pending_step_up: 'Waiting for step-up',
  delayed: 'Cooling-off delay',
  held_for_review: 'Held for review',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
  reversed: 'Reversed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};
