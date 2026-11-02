import type { Schema } from '@nem/contracts';

import type { Tone } from '@/components';
import { isApiError } from '@/data';
import i18n, { withLabel } from '@/lib/i18n';

type MoneyRequest = Schema<'MoneyRequest'>;
type RequestStatus = Schema<'MoneyRequestStatus'>;

export const REQUEST_NOTE_MAX_LENGTH = 100;
const DAY_MS = 86_400_000;

/** How long the friend has to pay: the contract allows 1 to 30 days. */
export const EXPIRY_CHOICES = ([1, 7, 30] as const).map((days) => ({
  days,
  get label() {
    return i18n.t('common.days', { count: days });
  },
}));
export const DEFAULT_EXPIRY_DAYS = 7;

export const REQUEST_STATUS: Record<RequestStatus, { readonly label: string; tone: Tone }> = {
  pending: withLabel('transfers.requests.status.pending', { tone: 'warning' }),
  paid: withLabel('transfers.requests.status.paid', { tone: 'success' }),
  declined: withLabel('transfers.requests.status.declined', { tone: 'danger' }),
  cancelled: withLabel('transfers.requests.status.cancelled', { tone: 'neutral' }),
  expired: withLabel('transfers.requests.status.expired', { tone: 'neutral' }),
};

/** The other person: who asked, for an incoming request; who pays, for one sent. */
export const counterpartOf = (r: MoneyRequest) =>
  r.direction === 'incoming' ? r.requester : r.payer;

/** "today", "tomorrow", "in 6 days" until the request lapses. */
export function expiresIn(expiresAt: string, now: number = Date.now()): string {
  const days = Math.ceil((Date.parse(expiresAt) - now) / DAY_MS);
  if (days <= 0) return i18n.t('transfers.requests.expires.today');
  if (days === 1) return i18n.t('transfers.requests.expires.tomorrow');
  return i18n.t('transfers.requests.expires.inDays', { count: days });
}

/** The second line of a request row: the note, then where it stands. */
export function requestSubtitle(r: MoneyRequest, now: number = Date.now()): string {
  const note = r.note || i18n.t('transfers.requests.noNote');
  if (r.status !== 'pending') {
    return i18n.t('transfers.requests.subtitleClosed', {
      note,
      status: REQUEST_STATUS[r.status].label.toLowerCase(),
    });
  }
  return i18n.t('transfers.requests.subtitleOpen', { note, when: expiresIn(r.expires_at, now) });
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
  if (!isApiError(error)) return i18n.t('common.tryAgainGeneric');
  if (error.code === 'invalid_state') return i18n.t('transfers.requests.notOpen');
  if (error.code === 'offline') return i18n.t('common.offline');
  return error.problem.detail ?? i18n.t('common.tryAgainGeneric');
}
