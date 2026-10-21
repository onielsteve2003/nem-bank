import type { Schema } from '@nem/contracts';
import { CURRENCIES, type CurrencyCode } from '@nem/shared';

// How money from abroad reaches a foreign wallet (FX-3). Each wallet has local
// details in its own country, so a sender pays it like any domestic account:
// no SWIFT chain, no correspondent fees taken out on the way.

type Scheme = Schema<'ReceivingDetails'>['scheme'];
type ForeignScheme = Exclude<Scheme, 'nuban'>;

export interface ReceiveGuide {
  /** The payment network the sender uses. */
  rail: string;
  /** How long it usually takes, from the sender's side. */
  speed: string;
  /** Who typically pays into this kind of wallet. */
  payers: string;
}

export const RECEIVE_GUIDES: Record<ForeignScheme, ReceiveGuide> = {
  us_ach: {
    rail: 'ACH or domestic wire in the US',
    speed: '1 to 3 business days by ACH, same day by wire',
    payers: 'US clients, Upwork, Deel, Payoneer and payroll',
  },
  uk_fps: {
    rail: 'Faster Payments in the UK',
    speed: 'Usually within minutes, any day of the week',
    payers: 'UK employers, family and friends, Wise and Revolut',
  },
  iban: {
    rail: 'SEPA transfer in the euro area',
    speed: 'Next business day, or seconds with SEPA Instant',
    payers: 'European clients, marketplaces and family in the EU',
  },
};

export const isForeignScheme = (scheme: Scheme): scheme is ForeignScheme => scheme !== 'nuban';

/** The four steps from sharing details to spending the money, in plain words. */
export function receiveSteps(currency: CurrencyCode, guide: ReceiveGuide): string[] {
  const name = CURRENCIES[currency].name;
  return [
    'Share these details with whoever is paying you.',
    `They pay from their own bank by ${guide.rail}, like paying any local account.`,
    `It lands in your ${currency} wallet as ${name}, and we tell you the moment it does.`,
    'Keep it, or convert it to naira at a live rate whenever you choose.',
  ];
}
