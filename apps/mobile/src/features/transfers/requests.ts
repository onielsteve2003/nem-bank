import type { Schema } from '@nem/contracts';

import type { Tone } from '@/components';
import { isApiError } from '@/data';

type MoneyRequest = Schema<'MoneyRequest'>;
type RequestStatus = Schema<'MoneyRequestStatus'>;

export const REQUEST_NOTE_MAX_LENGTH = 100;
const DAY_MS = 86_400_000;

/** How long the friend has to pay: the contract allows 1 to 30 days. */
export const EXPIRY_CHOICES = [
  { days: 1, label: '1 day' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
] as const;
export const DEFAULT_EXPIRY_DAYS = 7;

export const REQUEST_STATUS: Record<RequestStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Waiting', tone: 'warning' },
  paid: { label: 'Paid', tone: 'success' },
  declined: { label: 'Declined', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'neutral' },
};

/** The other person: who asked, for an incoming request; who pays, for one sent. */
export const counterpartOf = (r: MoneyRequest) =>
  r.direction === 'incoming' ? r.requester : r.payer;

/** "today", "tomorrow", "in 6 days" until the request lapses. */
export function expiresIn(expiresAt: string, now: number = Date.now()): string {
  const days = Math.ceil((Date.parse(expiresAt) - now) / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/** The second line of a request row: the note, then where it stands. */
export function requestSubtitle(r: MoneyRequest, now: number = Date.now()): string {
  const note = r.note || 'No note';
  if (r.status !== 'pending') return `${note} · ${REQUEST_STATUS[r.status].label.toLowerCase()}`;
  return `${note} · expires ${expiresIn(r.expires_at, now)}`;
}

/** Open requests first (the one lapsing soonest on top), then the rest newest first. */
export function sortRequests(list: MoneyRequest[]): MoneyRequest[] {
  const open = (r: MoneyRequest) => (r.status === 'pending' ? 0 : 1);
  return [...list].sort(
    (a, b) =>
      open(a) - open(b) ||
      (a.status === 'pending'
        ? a.expires_at.localeCompare(b.expires_at)
        : b.created_at.localeCompare(a.created_at)),
  );
}

export const openCount = (list: MoneyRequest[] | undefined) =>
  list?.filter((r) => r.status === 'pending').length ?? 0;

/** What a pay or decline failure means for the customer. */
export function requestErrorMessage(error: Error): string {
  if (!isApiError(error)) return "We couldn't do that. Try again.";
  if (error.code === 'invalid_state') return 'This request is no longer open.';
  if (error.code === 'offline') return "You're offline. Reconnect and try again.";
  return error.problem.detail ?? "We couldn't do that. Try again.";
}
