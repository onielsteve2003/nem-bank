import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';

import type { Tone } from '@/components';
import { isApiError } from '@/data';
import { fromApiMoney } from '@/lib/money';

type PaymentLink = Schema<'PaymentLink'>;
type LinkStatus = PaymentLink['status'];

/** The contract's limits on what a link says (CreatePaymentLinkRequest). */
export const LINK_TITLE_MAX_LENGTH = 60;
export const LINK_NOTE_MAX_LENGTH = 200;
export const PAY_NOTE_MAX_LENGTH = 100;
const DAY_MS = 86_400_000;

/** How long a new link takes payments; `null` keeps it open until it is turned off. */
export const LINK_EXPIRY_CHOICES = [
  { days: null, label: 'No end date' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
] as const;
export type LinkExpiryDays = (typeof LINK_EXPIRY_CHOICES)[number]['days'];

export const LINK_STATUS: Record<LinkStatus, { label: string; tone: Tone }> = {
  active: { label: 'Taking payments', tone: 'success' },
  inactive: { label: 'Paused', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'neutral' },
};

/** When a link made now with this choice stops taking payments. */
export function linkExpiresAt(days: LinkExpiryDays, now: number = Date.now()): string | undefined {
  return days === null ? undefined : new Date(now + days * DAY_MS).toISOString();
}

/** "₦5,000.00" for a fixed link, "Any amount" for an open one. */
export function linkAmountLabel(link: Pick<PaymentLink, 'amount_mode' | 'amount'>): string {
  return link.amount_mode === 'fixed' && link.amount
    ? formatMoney(fromApiMoney(link.amount))
    : 'Any amount';
}

/** The second line of a link row: what it asks for, then what it has brought in. */
export function linkSubtitle(link: PaymentLink): string {
  const amount = linkAmountLabel(link);
  if (link.payments_count === 0) return `${amount} · no payments yet`;
  const count = link.payments_count === 1 ? '1 payment' : `${link.payments_count} payments`;
  return `${amount} · ${count} · ${formatMoney(fromApiMoney(link.total_received))} in`;
}

/** What goes out with Share: enough for the payer to know what the link is before tapping it. */
export function linkShareMessage(
  link: Pick<PaymentLink, 'title' | 'url' | 'amount_mode' | 'amount'>,
) {
  const amount = link.amount_mode === 'fixed' ? ` (${linkAmountLabel(link)})` : '';
  return `Pay me for ${link.title}${amount} with Nem: ${link.url}`;
}

/** Why a public link cannot be paid right now, or null when it can. */
export function linkClosedReason(status: LinkStatus): string | null {
  if (status === 'inactive') return 'This link is paused. Ask the person who sent it.';
  if (status === 'expired') return 'This link has expired. Ask for a new one.';
  return null;
}

/** What a create or update failure means for the customer. */
export function linkErrorMessage(error: Error): string {
  if (!isApiError(error)) return "We couldn't do that. Try again.";
  if (error.code === 'offline') return "You're offline. Reconnect and try again.";
  if (error.code === 'invalid_state') return 'This link has expired. Make a new one.';
  return error.problem.detail ?? error.problem.title ?? "We couldn't do that. Try again.";
}
