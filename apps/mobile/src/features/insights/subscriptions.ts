import type { Schema } from '@nem/contracts';

import { cardName, isOpen } from '@/features/cards/cards';
import i18n, { localized } from '@/lib/i18n';

import { longDate } from './forecast';

type Subscription = Schema<'DetectedSubscription'>;
type Card = Schema<'Card'>;

const DAY = 86_400_000;

export const FREQUENCY_LABEL = localized<Subscription['frequency']>({
  weekly: 'insights.subscriptions.frequency.weekly',
  monthly: 'insights.subscriptions.frequency.monthly',
  yearly: 'insights.subscriptions.frequency.yearly',
});

/** Whole days from `today` (YYYY-MM-DD) to `date`; negative once it has passed. */
export const daysUntil = (date: string, today: string) =>
  Math.round(
    (new Date(`${date}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / DAY,
  );

/** "Next charge today", "… tomorrow", "… Tue, 3 Nov (in 6 days)" or "Was due 1 Nov". */
export function nextChargeLabel(date: string, today: string): string {
  const days = daysUntil(date, today);
  if (days < 0) return i18n.t('insights.subscriptions.wasDue', { date: longDate(date) });
  if (days === 0) return i18n.t('insights.subscriptions.today');
  if (days === 1) return i18n.t('insights.subscriptions.tomorrow');
  return i18n.t('insights.subscriptions.inDays', { date: longDate(date), count: days });
}

export type PaidWith =
  | { kind: 'card'; card: Card; label: string; warning: string | null }
  | { kind: 'wallet'; label: string };

/**
 * What a subscription is paid with. A card that is frozen or closed will turn
 * the next charge down, which is worth saying before it happens.
 */
export function paidWith(sub: Subscription, cards: readonly Card[]): PaidWith {
  const card = sub.card_id ? cards.find((c) => c.id === sub.card_id) : undefined;
  if (!card) return { kind: 'wallet', label: i18n.t('insights.subscriptions.wallet') };
  const label = i18n.t('insights.subscriptions.cardEnding', {
    name: cardName(card),
    last4: card.last4,
  });
  const warning = !isOpen(card)
    ? i18n.t('insights.subscriptions.closed')
    : card.status === 'frozen'
      ? i18n.t('insights.subscriptions.frozen')
      : null;
  return { kind: 'card', card, label, warning };
}
