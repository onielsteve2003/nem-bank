import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';

import type { Tone } from '@/components';
import { isApiError } from '@/data';
import { fromApiMoney } from '@/lib/money';
import i18n, { withLabel } from '@/lib/i18n';

type PaymentLink = Schema<'PaymentLink'>;
type LinkStatus = PaymentLink['status'];

/** The contract's limits on what a link says (CreatePaymentLinkRequest). */
export const LINK_TITLE_MAX_LENGTH = 60;
export const LINK_NOTE_MAX_LENGTH = 200;
export const PAY_NOTE_MAX_LENGTH = 100;
const DAY_MS = 86_400_000;

/** How long a new link takes payments; `null` keeps it open until it is turned off. */
export const LINK_EXPIRY_CHOICES = [
  withLabel('transfers.links.expiry.none', { days: null }),
  {
    days: 7,
    get label() {
      return i18n.t('common.days', { count: 7 });
    },
  },
  {
    days: 30,
    get label() {
      return i18n.t('common.days', { count: 30 });
    },
  },
] as const;
export type LinkExpiryDays = (typeof LINK_EXPIRY_CHOICES)[number]['days'];

export const LINK_STATUS: Record<LinkStatus, { readonly label: string; tone: Tone }> = {
  active: withLabel('transfers.links.status.active', { tone: 'success' }),
  inactive: withLabel('transfers.links.status.inactive', { tone: 'neutral' }),
  expired: withLabel('transfers.links.status.expired', { tone: 'neutral' }),
};

/** When a link made now with this choice stops taking payments. */
export function linkExpiresAt(days: LinkExpiryDays, now: number = Date.now()): string | undefined {
  return days === null ? undefined : new Date(now + days * DAY_MS).toISOString();
}

/** "₦5,000.00" for a fixed link, "Any amount" for an open one. */
export function linkAmountLabel(link: Pick<PaymentLink, 'amount_mode' | 'amount'>): string {
  return link.amount_mode === 'fixed' && link.amount
    ? formatMoney(fromApiMoney(link.amount))
    : i18n.t('transfers.links.anyAmount');
}

/** The second line of a link row: what it asks for, then what it has brought in. */
export function linkSubtitle(link: PaymentLink): string {
  const amount = linkAmountLabel(link);
  if (link.payments_count === 0) return i18n.t('transfers.links.noPayments', { amount });
  return i18n.t('transfers.links.payments', {
    amount,
    count: link.payments_count,
    total: formatMoney(fromApiMoney(link.total_received)),
  });
}

/** What goes out with Share: enough for the payer to know what the link is before tapping it. */
export function linkShareMessage(
  link: Pick<PaymentLink, 'title' | 'url' | 'amount_mode' | 'amount'>,
) {
  const amount = link.amount_mode === 'fixed' ? ` (${linkAmountLabel(link)})` : '';
  return i18n.t('transfers.links.shareMessage', { title: link.title, amount, url: link.url });
}

/** Why a public link cannot be paid right now, or null when it can. */
export function linkClosedReason(status: LinkStatus): string | null {
  if (status === 'inactive') return i18n.t('transfers.links.paused');
  if (status === 'expired') return i18n.t('transfers.links.expired');
  return null;
}

/** What a create or update failure means for the customer. */
export function linkErrorMessage(error: Error): string {
  if (!isApiError(error)) return i18n.t('common.tryAgainGeneric');
  if (error.code === 'offline') return i18n.t('common.offline');
  if (error.code === 'invalid_state') return i18n.t('transfers.links.expiredMakeNew');
  return error.problem.detail ?? error.problem.title ?? i18n.t('common.tryAgainGeneric');
}
