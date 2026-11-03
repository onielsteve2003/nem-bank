import type { Schema } from '@nem/contracts';

import type { Tone } from '@/components/Badge';

type Status = Schema<'CustomerSummary'>['status'];
type Flag = Schema<'Customer360'>['flags'][number];

export const STATUS_TONE: Readonly<Record<Status, Tone>> = {
  active: 'success',
  frozen: 'danger',
  closed: 'neutral',
};

export const STATUS_LABELS: Readonly<Record<Status, string>> = {
  active: 'Active',
  frozen: 'Frozen',
  closed: 'Closed',
};

export const FLAG_LABELS: Readonly<Record<Flag, [label: string, tone: Tone]>> = {
  frozen: ['Frozen', 'danger'],
  duress_triggered: ['Duress PIN used', 'danger'],
  fraud_watch: ['Fraud watch', 'warning'],
  new_device_cool_off: ['New-device cool-off', 'warning'],
  limit_override: ['Limit override', 'info'],
  demo: ['Demo account', 'neutral'],
};
