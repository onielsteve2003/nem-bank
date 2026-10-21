import type { Schema } from '@nem/contracts';

type Conversion = Schema<'FxConversion'>;

/** "USD to NGN". */
export const conversionTitle = (c: Conversion) => `${c.sell.currency} to ${c.buy.currency}`;

/** The foreign currency in a conversion: every conversion has naira on one side (FX-1). */
export const foreignSide = (c: Conversion) =>
  c.sell.currency === 'NGN' ? c.buy.currency : c.sell.currency;
