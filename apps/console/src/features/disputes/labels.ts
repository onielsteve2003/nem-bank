import type { Schema } from '@nem/contracts';

import type { Tone } from '@/components/Badge';

import type { DisputeFilter } from './useDisputes';

export const FILTERS: readonly { value: DisputeFilter; label: string }[] = [
  { value: 'active', label: 'Open' },
  { value: 'resolved_refunded', label: 'Refunded' },
  { value: 'resolved_declined', label: 'Declined' },
];

export const DISPUTE_STATUS: Readonly<
  Record<Schema<'DisputeStatus'>, [label: string, tone: Tone]>
> = {
  submitted: ['New', 'warning'],
  under_review: ['In review', 'info'],
  awaiting_customer: ['Waiting on customer', 'neutral'],
  resolved_refunded: ['Refunded', 'success'],
  resolved_declined: ['Declined', 'danger'],
  withdrawn: ['Withdrawn', 'neutral'],
};

export const REASONS: Readonly<Record<Schema<'DisputeReason'>, string>> = {
  not_received: 'Service not received',
  wrong_amount: 'Wrong amount',
  duplicate_charge: 'Charged twice',
  unauthorised: 'Not made by the customer',
  goods_not_received: 'Goods not received',
  failed_but_debited: 'Failed but debited',
  other: 'Other',
};
