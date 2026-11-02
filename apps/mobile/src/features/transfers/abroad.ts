import type { Schema } from '@nem/contracts';
import { money, parseRate, type CurrencyCode, type Money } from '@nem/shared';
import i18n, { withLabel } from '@/lib/i18n';

type Purpose = Schema<'InternationalTransferRequest'>['purpose'];
const naira = (major: number): Money => money(BigInt(major) * 100n, 'NGN');
export type AbroadCurrency = Exclude<CurrencyCode, 'NGN'>;

/** Where money can go once a remittance partner is connected, and what arrives there. */
export const DESTINATIONS = [
  { country: 'GB', name: 'United Kingdom', flag: '🇬🇧', currency: 'GBP', needsBic: false },
  { country: 'US', name: 'United States', flag: '🇺🇸', currency: 'USD', needsBic: true },
  { country: 'IE', name: 'Ireland', flag: '🇮🇪', currency: 'EUR', needsBic: false },
  { country: 'DE', name: 'Germany', flag: '🇩🇪', currency: 'EUR', needsBic: false },
  { country: 'FR', name: 'France', flag: '🇫🇷', currency: 'EUR', needsBic: false },
] as const satisfies readonly {
  country: string;
  name: string;
  flag: string;
  currency: AbroadCurrency;
  needsBic: boolean;
}[];
export type Destination = (typeof DESTINATIONS)[number];

export const PURPOSES: { value: Purpose; readonly label: string }[] = (
  ['family_support', 'education', 'medical', 'business', 'other'] as const
).map((value) => withLabel(`transfers.abroad.purposes.${value}`, { value }));

/** How long a partner usually takes to deliver, shown before anyone commits. */
export const deliveryEstimate = () => i18n.t('transfers.abroad.delivery');

/**
 * The partner's fee as the product would show it: 1% of the amount, at least
 * ₦2,000 and at most ₦25,000. Indicative only; a real partner sets its own.
 */
export const ABROAD_FEE = { pctBps: 100, min: naira(2_000), max: naira(25_000) } as const;

export function abroadFee(amount: Money): Money {
  const pct = (amount.amount * BigInt(ABROAD_FEE.pctBps)) / 10_000n;
  const fee = pct < ABROAD_FEE.min.amount ? ABROAD_FEE.min.amount : pct;
  return money(fee > ABROAD_FEE.max.amount ? ABROAD_FEE.max.amount : fee, 'NGN');
}

/**
 * What the recipient would get for `amount` naira at `buyRate` (naira per one
 * unit of their currency, spread included). Rounded down: never promise more
 * than arrives.
 */
export function receiveEstimate(amount: Money, buyRate: string, to: AbroadCurrency): Money {
  const { numerator, denominator } = parseRate(buyRate);
  // Naira and the destination currencies all have two minor digits.
  return money((amount.amount * denominator) / numerator, to);
}

/** The recipient fields, checked the way a partner would before accepting them. */
export function recipientProblems(
  input: { name: string; account: string; bic: string },
  destination: Destination,
): { name?: string; account?: string; bic?: string } {
  const problems: { name?: string; account?: string; bic?: string } = {};
  const name = input.name.trim();
  if (name.length > 0 && !/^[\p{L}][\p{L} .'-]+\s+[\p{L}][\p{L} .'-]*$/u.test(name)) {
    problems.name = i18n.t('transfers.abroad.fullName');
  }
  const account = input.account.replace(/\s+/g, '').toUpperCase();
  if (account.length > 0) {
    const valid =
      destination.country === 'US'
        ? /^\d{4,17}$/.test(account)
        : destination.country === 'GB'
          ? /^(\d{8}|GB\d{2}[A-Z]{4}\d{14})$/.test(account)
          : new RegExp(`^${destination.country}\\d{2}[A-Z0-9]{11,30}$`).test(account);
    if (!valid) problems.account = accountHelp(destination);
  }
  const bic = input.bic.replace(/\s+/g, '').toUpperCase();
  if (bic.length > 0 && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)) {
    problems.bic = i18n.t('transfers.abroad.badBic');
  }
  return problems;
}

export function accountLabel(destination: Destination): string {
  if (destination.country === 'US') return i18n.t('transfers.abroad.accountNumber');
  if (destination.country === 'GB') return i18n.t('transfers.abroad.accountOrIban');
  return i18n.t('transfers.abroad.iban');
}

function accountHelp(destination: Destination): string {
  if (destination.country === 'US') return i18n.t('transfers.abroad.usHelp');
  if (destination.country === 'GB') return i18n.t('transfers.abroad.gbHelp');
  return i18n.t('transfers.abroad.ibanHelp', {
    country: destination.name,
    code: destination.country,
  });
}
