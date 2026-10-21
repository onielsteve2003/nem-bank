import type { Schema } from '@nem/contracts';
import { keepPreviousData } from '@tanstack/react-query';

import { useSecondsUntil } from '@/features/auth/otp';
import { toApiMoney } from '@/lib/money';
import { useRepoQuery } from '@/lib/query';
import { useDebounced } from '@/lib/useDebounced';

import { quoteDeadline, typedAmount } from '../quote';

type Account = Schema<'Account'>;

const QUOTE_DELAY_MS = 300;

/**
 * A live quote for selling the typed amount from `from` into `to` (FX-1),
 * priced once typing settles. `current` is the quote for exactly what is on
 * screen (the one shown may still be for the previous amount), and `live` says
 * it can be confirmed: it matches, it has not expired and no new rate is loading.
 */
export function useFxQuote(from: Account | undefined, to: Account | undefined, typed: string) {
  const sell = from ? typedAmount(typed, from.currency) : null;
  const settled = useDebounced(typed, QUOTE_DELAY_MS);
  const settledSell = from ? typedAmount(settled, from.currency) : null;
  const quote = useRepoQuery(
    'fx',
    'createQuote',
    from && to && settledSell
      ? {
          body: {
            from_account_id: from.id,
            to_account_id: to.id,
            sell_amount: toApiMoney(settledSell),
          },
        }
      : undefined,
    {
      enabled: Boolean(from && to && settledSell),
      placeholderData: keepPreviousData,
      // A new rate only when the customer asks for one or changes the amount.
      staleTime: Infinity,
      gcTime: 0,
      refetchOnWindowFocus: false,
    },
  );
  const secondsLeft = useSecondsUntil(quoteDeadline(quote.dataUpdatedAt));
  const current =
    quote.data &&
    sell &&
    to &&
    quote.data.to_account_id === to.id &&
    quote.data.sell.amount_minor === sell.amount.toString()
      ? quote.data
      : null;
  const live = Boolean(current && secondsLeft > 0 && !quote.isFetching);
  return { sell, quote, current, secondsLeft, live };
}
