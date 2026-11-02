import type { Schema } from '@nem/contracts';
import { CURRENCIES, type CurrencyCode } from '@nem/shared';
import i18n from '@/lib/i18n';

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

const guide = (scheme: ForeignScheme): ReceiveGuide => ({
  get rail() {
    return i18n.t(`fx.receive.guides.${scheme}.rail`);
  },
  get speed() {
    return i18n.t(`fx.receive.guides.${scheme}.speed`);
  },
  get payers() {
    return i18n.t(`fx.receive.guides.${scheme}.payers`);
  },
});

export const RECEIVE_GUIDES: Record<ForeignScheme, ReceiveGuide> = {
  us_ach: guide('us_ach'),
  uk_fps: guide('uk_fps'),
  iban: guide('iban'),
};

export const isForeignScheme = (scheme: Scheme): scheme is ForeignScheme => scheme !== 'nuban';

/** The four steps from sharing details to spending the money, in plain words. */
export function receiveSteps(currency: CurrencyCode, guide: ReceiveGuide): string[] {
  const name = CURRENCIES[currency].name;
  return [
    i18n.t('fx.receive.steps.share'),
    i18n.t('fx.receive.steps.pay', { rail: guide.rail }),
    i18n.t('fx.receive.steps.lands', { currency, name }),
    i18n.t('fx.receive.steps.keep'),
  ];
}
