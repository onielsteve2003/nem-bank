import { z } from 'zod';

export const CURRENCY_CODES = ['NGN', 'USD', 'GBP', 'EUR'] as const;

export type CurrencyCode = (typeof CURRENCY_CODES)[number];

export const currencyCodeSchema = z.enum(CURRENCY_CODES);

export interface Currency {
  readonly code: CurrencyCode;
  readonly name: string;
  readonly symbol: string;
  /** Digits after the decimal point; 100 kobo = 1 naira, so NGN has 2. */
  readonly minorDigits: number;
  readonly flag: string;
}

export const CURRENCIES: Readonly<Record<CurrencyCode, Currency>> = {
  NGN: { code: 'NGN', name: 'Nigerian Naira', symbol: '₦', minorDigits: 2, flag: '🇳🇬' },
  USD: { code: 'USD', name: 'US Dollar', symbol: '$', minorDigits: 2, flag: '🇺🇸' },
  GBP: { code: 'GBP', name: 'British Pound', symbol: '£', minorDigits: 2, flag: '🇬🇧' },
  EUR: { code: 'EUR', name: 'Euro', symbol: '€', minorDigits: 2, flag: '🇪🇺' },
};

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return currencyCodeSchema.safeParse(value).success;
}
