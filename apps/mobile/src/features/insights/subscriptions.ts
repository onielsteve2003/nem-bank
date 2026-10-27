import type { Schema } from '@nem/contracts';

import { cardName, isOpen } from '@/features/cards/cards';

import { longDate } from './forecast';

type Subscription = Schema<'DetectedSubscription'>;
type Card = Schema<'Card'>;

const DAY = 86_400_000;

export const FREQUENCY_LABEL: Record<Subscription['frequency'], string> = {
  weekly: 'a week',
  monthly: 'a month',
  yearly: 'a year',
};

/** Whole days from `today` (YYYY-MM-DD) to `date`; negative once it has passed. */
export const daysUntil = (date: string, today: string) =>
  Math.round(
    (new Date(`${date}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / DAY,
  );

/** "Next charge today", "… tomorrow", "… Tue, 3 Nov (in 6 days)" or "Was due 1 Nov". */
export function nextChargeLabel(date: string, today: string): string {
  const days = daysUntil(date, today);
  if (days < 0) return `Was due ${longDate(date)}`;
  if (days === 0) return 'Next charge today';
  if (days === 1) return 'Next charge tomorrow';
  return `Next charge ${longDate(date)} (in ${days} days)`;
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
  if (!card) return { kind: 'wallet', label: 'Paid from your wallet as a bill' };
  const label = `${cardName(card)} ending ${card.last4}`;
  const warning = !isOpen(card)
    ? 'This card is closed, so the next charge will be declined.'
    : card.status === 'frozen'
      ? 'This card is frozen, so the next charge will be declined.'
      : null;
  return { kind: 'card', card, label, warning };
}
