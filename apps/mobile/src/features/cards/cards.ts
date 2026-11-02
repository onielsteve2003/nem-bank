import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';

import type { CardDesign, CardNetwork } from '@/components';
import { parseNairaText } from '@/features/transfers/splits';
import i18n, { withLabel } from '@/lib/i18n';
import { fromApiMoney } from '@/lib/money';

// Virtual cards (CARD-1): how each card is named, described and drawn.

type Card = Schema<'Card'>;
export type CardType = Card['type'];
export type CardCurrency = Card['currency'];

/** Simulated networks on Nem's test BINs (CARD-7), drawn with the familiar brand. */
const NETWORKS: Record<Card['network'], CardNetwork> = { nem_verve: 'verve', nem_visa: 'visa' };

/** A card type's words, read in the current language on access. */
const cardType = (type: CardType) => ({
  get label() {
    return i18n.t(`cards.types.${type}.label`);
  },
  get description() {
    return i18n.t(`cards.types.${type}.description`);
  },
});

export const CARD_TYPES: Record<
  CardType,
  { readonly label: string; readonly description: string }
> = {
  standard: cardType('standard'),
  single_use: cardType('single_use'),
  merchant_locked: cardType('merchant_locked'),
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
export const cardName = (card: Card) =>
  card.nickname ?? i18n.t('cards.typeCard', { type: CARD_TYPES[card.type].label });

/** "Single-use · NGN · ends 4821", with the lock and limit when set. */
export function cardFacts(card: Card): string[] {
  const facts = [
    i18n.t('cards.facts.summary', {
      type: CARD_TYPES[card.type].label,
      currency: card.currency,
      last4: card.last4,
    }),
  ];
  const lock = card.controls.merchant_lock;
  if (lock) facts.push(i18n.t('cards.facts.lockedTo', { merchant: lock.merchant_name }));
  if (card.controls.spend_limit)
    facts.push(i18n.t('cards.facts.limit', { limit: limitSummary(card) }));
  return facts;
}

/** Why a closed card is closed, in a word. */
export const closedReason = (card: Card) =>
  i18n.t(card.status === 'used' ? 'cards.closedReason.used' : 'cards.closedReason.terminated');

/** "5060 9912 3456 7890": the PAN in groups of four, as printed on cards. */
export const groupPan = (pan: string) => pan.replace(/(\d{4})(?=\d)/g, '$1 ');

export type LimitPeriod = Schema<'SpendLimit'>['period'];

export const LIMIT_PERIODS: { value: LimitPeriod; label: string }[] = [
  withLabel('cards.limit.periods.per_transaction', { value: 'per_transaction' as const }),
  withLabel('cards.limit.periods.daily', { value: 'daily' as const }),
  withLabel('cards.limit.periods.monthly', { value: 'monthly' as const }),
];

/** A typed limit ("50,000", "$25.50") in the card's minor units, or null if not a positive amount. */
export const parseLimit = (text: string) => parseNairaText(text.replace(/\$/g, ''));

/** "₦200,000 a day", or "No limit". */
export function limitSummary(card: Card): string {
  const limit = card.controls.spend_limit;
  if (!limit) return i18n.t('cards.limit.none');
  const amount = formatMoney(fromApiMoney(limit.amount), { trimZeroMinor: true });
  return i18n.t(`cards.limit.summary.${limit.period}`, { amount });
}

/** Pending authorisations first, then everything that has settled or dropped off. */
export function splitCardPayments(payments: Schema<'CardTransaction'>[]) {
  return {
    pending: payments.filter((p) => p.status === 'authorized'),
    done: payments.filter((p) => p.status !== 'authorized'),
  };
}

/** The 36 states and the FCT, where a physical card could be posted (CARD-8). */
export const NIGERIAN_STATES = [
  'Abia',
  'Adamawa',
  'Akwa Ibom',
  'Anambra',
  'Bauchi',
  'Bayelsa',
  'Benue',
  'Borno',
  'Cross River',
  'Delta',
  'Ebonyi',
  'Edo',
  'Ekiti',
  'Enugu',
  'FCT',
  'Gombe',
  'Imo',
  'Jigawa',
  'Kaduna',
  'Kano',
  'Katsina',
  'Kebbi',
  'Kogi',
  'Kwara',
  'Lagos',
  'Nasarawa',
  'Niger',
  'Ogun',
  'Ondo',
  'Osun',
  'Oyo',
  'Plateau',
  'Rivers',
  'Sokoto',
  'Taraba',
  'Yobe',
  'Zamfara',
] as const;

export type DeliveryAddress = {
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
};

/** What's wrong with a typed delivery address, field by field; empty fields are just incomplete. */
export function addressProblems(
  a: DeliveryAddress,
): Partial<Record<keyof DeliveryAddress, string>> {
  const problems: Partial<Record<keyof DeliveryAddress, string>> = {};
  if (a.line1.trim() && a.line1.trim().length < 5)
    problems.line1 = i18n.t('cards.address.problems.line1');
  if (a.city.trim() && !/^[A-Za-z][A-Za-z .'-]+$/.test(a.city.trim()))
    problems.city = i18n.t('cards.address.problems.city');
  if (a.postalCode.trim() && !/^\d{6}$/.test(a.postalCode.trim()))
    problems.postalCode = i18n.t('cards.address.problems.postalCode');
  return problems;
}

/** Ready to send: the required fields are filled and nothing is wrong. */
export const addressComplete = (a: DeliveryAddress) =>
  Boolean(a.line1.trim() && a.city.trim() && a.state) &&
  Object.keys(addressProblems(a)).length === 0;

/** A typed address in the API's shape: trimmed, optional fields left out when empty. */
export const toApiAddress = (a: DeliveryAddress): Schema<'Address'> => ({
  line1: a.line1.trim(),
  ...(a.line2.trim() && { line2: a.line2.trim() }),
  city: a.city.trim(),
  state: a.state,
  ...(a.postalCode.trim() && { postal_code: a.postalCode.trim() }),
  country: 'NG',
});
