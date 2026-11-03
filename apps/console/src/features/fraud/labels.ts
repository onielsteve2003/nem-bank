import type { Schema } from '@nem/contracts';

import type { Tone } from '@/components/Badge';

import type { FraudCase, FraudFilter } from './useFraud';

export const FILTERS: readonly { value: FraudFilter; label: string }[] = [
  { value: 'active', label: 'Needs action' },
  { value: 'released', label: 'Released' },
  { value: 'rejected', label: 'Rejected' },
];

export const CASE_STATUS: Readonly<Record<FraudCase['status'], [label: string, tone: Tone]>> = {
  open: ['Open', 'warning'],
  in_review: ['In review', 'info'],
  released: ['Released', 'success'],
  rejected: ['Rejected', 'danger'],
};

export const SEVERITY: Readonly<Record<Schema<'RiskReason'>['severity'], Tone>> = {
  low: 'neutral',
  medium: 'warning',
  high: 'danger',
};

export const LABELS: readonly { value: Schema<'FraudLabel'>; label: string; hint: string }[] = [
  { value: 'fraud', label: 'Fraud', hint: 'Confirmed scam, takeover or mule.' },
  { value: 'legitimate', label: 'Legitimate', hint: 'The customer meant to send it.' },
  { value: 'unsure', label: 'Unsure', hint: 'Kept out of training until confirmed.' },
];

/** Scores travel as 0–1; staff read them out of 100, the way the engine's thresholds are set. */
export const scoreOutOf100 = (score: number): number => Math.round(score * 100);

export function scoreTone(score: number): Tone {
  if (score >= 0.8) return 'danger';
  if (score >= 0.6) return 'warning';
  return 'neutral';
}

/** Ages as staff say them: "6 h", "4 d", "new". */
export function formatAge(hours: number | null | undefined): string {
  if (hours === null || hours === undefined) return '—';
  if (hours < 1) return 'new';
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}
