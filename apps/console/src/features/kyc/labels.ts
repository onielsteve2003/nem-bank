import type { Schema } from '@nem/contracts';

import type { Tone } from '@/components/Badge';

import type { KycQueueStatus } from './useKyc';

export const QUEUE_STATUSES: readonly { status: KycQueueStatus; label: string }[] = [
  { status: 'pending_review', label: 'Waiting' },
  { status: 'resubmit', label: 'Asked to resubmit' },
  { status: 'approved', label: 'Approved' },
  { status: 'rejected', label: 'Rejected' },
];

export const SUBMISSION_STATUS: Readonly<Record<KycQueueStatus, [label: string, tone: Tone]>> = {
  pending_review: ['Waiting for review', 'warning'],
  approved: ['Approved', 'success'],
  rejected: ['Rejected', 'danger'],
  resubmit: ['Asked to resubmit', 'info'],
};

export const DOCUMENT_LABELS: Readonly<Record<Schema<'KycDocumentKind'>, string>> = {
  id_front: 'ID front',
  id_back: 'ID back',
  selfie: 'Selfie',
  proof_of_address: 'Proof of address',
};

export const QUALITY_LABELS: Readonly<
  Record<NonNullable<Schema<'KycDocument'>['quality_issues']>[number], string>
> = {
  blurry: 'Blurry',
  glare: 'Glare',
  cropped: 'Cropped',
  face_not_found: 'No face found',
};

export const NAME_MATCH: Readonly<
  Record<Schema<'NameMatch'>['result'], [label: string, tone: Tone]>
> = {
  match: ['Name matches', 'success'],
  close_match: ['Close name match', 'warning'],
  no_match: ['Name does not match', 'danger'],
};

/** Waiting time as staff say it: "5 h", "2 d 3 h". */
export function formatWaiting(hours: number): string {
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${days} d` : `${days} d ${rest} h`;
}

/** Past this the queue flags a submission as overdue (a day of waiting). */
export const OVERDUE_HOURS = 24;
