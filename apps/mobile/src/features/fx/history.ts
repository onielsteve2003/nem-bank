import type { Schema } from '@nem/contracts';
import i18n from '@/lib/i18n';

type Conversion = Schema<'FxConversion'>;

/** "USD to NGN". */
export const conversionTitle = (c: Conversion) =>
  i18n.t('fx.conversionTitle', { sell: c.sell.currency, buy: c.buy.currency });

/** The foreign currency in a conversion: every conversion has naira on one side (FX-1). */
export const foreignSide = (c: Conversion) =>
  c.sell.currency === 'NGN' ? c.buy.currency : c.sell.currency;
