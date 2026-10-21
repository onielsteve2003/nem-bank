import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';

import type { CardDesign, CardNetwork } from '@/components';
import { fromApiMoney } from '@/lib/money';

// Virtual cards (CARD-1): how each card is named, described and drawn.

type Card = Schema<'Card'>;
export type CardType = Card['type'];
export type CardCurrency = Card['currency'];

/** Simulated networks on Nem's test BINs (CARD-7), drawn with the familiar brand. */
const NETWORKS: Record<Card['network'], CardNetwork> = { nem_verve: 'verve', nem_visa: 'visa' };

export const CARD_TYPES: Record<CardType, { label: string; description: string }> = {
  standard: {
    label: 'Standard',
    description: 'For everyday spending online and in apps. Freeze or limit it any time.',
  },
  single_use: {
    label: 'Single-use',
    description:
      'Closes itself after one payment. Use it for a free trial or a site you don’t trust.',
  },
  merchant_locked: {
    label: 'Merchant-locked',
    description: 'Works at one merchant only. A leak there can’t be spent anywhere else.',
  },
};

export const CARD_DESIGNS: { value: CardDesign; label: string }[] = [
  { value: 'volt', label: 'Volt' },
  { value: 'noir', label: 'Noir' },
  { value: 'mint', label: 'Mint' },
  { value: 'coral', label: 'Coral' },
];

/**
 * Merchants a card can be locked to. The simulated processor matches on
 * `merchant_id`, which the Console Merchant Simulator charges as (CARD-7).
 */
export const LOCKABLE_MERCHANTS: Schema<'MerchantLock'>[] = [
  { merchant_id: 'mer_netflix', merchant_name: 'Netflix' },
  { merchant_id: 'mer_spotify', merchant_name: 'Spotify' },
  { merchant_id: 'mer_apple', merchant_name: 'Apple' },
  { merchant_id: 'mer_jumia', merchant_name: 'Jumia' },
  { merchant_id: 'mer_bolt', merchant_name: 'Bolt' },
  { merchant_id: 'mer_dstv', merchant_name: 'DStv' },
];

/** Still spendable, or can be again: these sit in the carousel. */
export const isOpen = (card: Card) => card.status === 'active' || card.status === 'frozen';

/** What the BankCard component needs to draw this card. */
export function bankCardProps(card: Card) {
  return {
    holder: card.name_on_card,
    last4: card.last4,
    expiry: `${String(card.expiry_month).padStart(2, '0')}/${String(card.expiry_year).slice(-2)}`,
    network: NETWORKS[card.network],
    kind: card.physical ? ('physical' as const) : ('virtual' as const),
    design: card.design,
    frozen: card.status === 'frozen',
  };
}

/** The card's own name, or its type when it has none. */
export const cardName = (card: Card) => card.nickname ?? `${CARD_TYPES[card.type].label} card`;

/** "Single-use · NGN · ends 4821", with the lock and limit when set. */
export function cardFacts(card: Card): string[] {
  const facts = [`${CARD_TYPES[card.type].label} · ${card.currency} · ends ${card.last4}`];
  const lock = card.controls.merchant_lock;
  if (lock) facts.push(`Only works at ${lock.merchant_name}`);
  const limit = card.controls.spend_limit;
  if (limit) {
    const per = { per_transaction: 'per payment', daily: 'a day', monthly: 'a month' }[
      limit.period
    ];
    facts.push(`Limit ${formatMoney(fromApiMoney(limit.amount), { trimZeroMinor: true })} ${per}`);
  }
  return facts;
}

/** Why a closed card is closed, in a word. */
export const closedReason = (card: Card) => (card.status === 'used' ? 'Used once' : 'Terminated');
