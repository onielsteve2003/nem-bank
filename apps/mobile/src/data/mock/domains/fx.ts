import type { Schema } from '@nem/contracts';
import {
  applySpread,
  convertAtRate,
  formatRate,
  FX_QUOTE_TTL_SECONDS,
  money,
  parseRate,
  zero,
  type CurrencyCode,
} from '@nem/shared';

import { problem } from '../../errors';
import type { FxRepo } from '../../repositories';
import { api, newestFirst, notFound, paginate, positive } from '../convert';
import { convertFx } from '../ledger';
import type { MockBank } from '../runtime';

// Indicative rates (FX-1). The server reads open.er-api.com / Frankfurter; the mock
// drifts a deterministic curve around realistic levels so charts look alive.

export const SPREAD_BPS = 150;
const BASE_RATES: Record<Exclude<CurrencyCode, 'NGN'>, number> = {
  USD: 1_585,
  GBP: 2_010,
  EUR: 1_720,
};
export const PAIRS = ['USD-NGN', 'GBP-NGN', 'EUR-NGN'] as const;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** NGN per one unit of `currency` at `at`, to 2 decimal places. */
export function midRate(currency: Exclude<CurrencyCode, 'NGN'>, at: number): string {
  const days = at / DAY;
  const wave =
    0.018 * Math.sin(days / 9) + 0.007 * Math.sin(days * 1.7) + 0.003 * Math.sin(at / HOUR);
  return (Math.round(BASE_RATES[currency] * (1 + wave) * 100) / 100).toFixed(2);
}

function invert(rate: string): string {
  const { numerator, denominator } = parseRate(rate);
  return formatRate({ numerator: denominator, denominator: numerator }, 'floor');
}

/** Customer buys `base` with naira: mid plus spread, rounded up (the bank's side). */
function askRate(mid: string): string {
  const { numerator, denominator } = parseRate(mid);
  return formatRate(
    { numerator: numerator * BigInt(10_000 + SPREAD_BPS), denominator: denominator * 10_000n },
    'ceil',
  );
}

function rateFor(pair: string, at: number): Schema<'FxRate'> {
  const [base, quote] = pair.split('-') as [Exclude<CurrencyCode, 'NGN'>, CurrencyCode];
  if (!PAIRS.includes(pair as (typeof PAIRS)[number])) {
    throw problem(422, 'validation_failed', `${pair} is not a supported pair`);
  }
  const mid = midRate(base, at);
  return {
    pair,
    base,
    quote,
    mid_rate: mid,
    buy_rate: applySpread(mid, SPREAD_BPS),
    sell_rate: askRate(mid),
    spread_bps: SPREAD_BPS,
    source: 'cache',
    as_of: new Date(Math.floor(at / 60_000) * 60_000).toISOString(),
  };
}

/** The customer rate from one wallet to another: units of `to` per unit of `from`. */
function customerRate(from: CurrencyCode, to: CurrencyCode, at: number) {
  if (to === 'NGN' && from !== 'NGN') {
    const r = rateFor(`${from}-NGN`, at);
    return { rate: r.buy_rate, mid: r.mid_rate };
  }
  if (from === 'NGN' && to !== 'NGN') {
    const r = rateFor(`${to}-NGN`, at);
    return { rate: invert(r.sell_rate), mid: invert(r.mid_rate) };
  }
  throw problem(422, 'validation_failed', 'Convert through naira (NGN) in the demo');
}

export function processFxAlerts(bank: MockBank): boolean {
  const now = bank.now().getTime();
  let changed = false;
  for (const alert of bank.world.fxAlerts) {
    if (alert.status !== 'active') continue;
    const mid = Number(rateFor(alert.pair, now).mid_rate);
    const target = Number(alert.target_rate);
    if (alert.direction === 'above' ? mid >= target : mid <= target) {
      alert.status = 'triggered';
      alert.triggered_at = bank.nowIso();
      changed = true;
      bank.notify({
        category: 'transactions',
        title: `${alert.pair.replace('-', '/')} is ${alert.direction} ${alert.target_rate}`,
        body: `The rate is now ${mid.toFixed(2)}. Tap to convert.`,
        deep_link: 'nembank://fx',
      });
    }
  }
  return changed;
}

const RANGES = {
  '1D': { points: 24, step: HOUR },
  '1W': { points: 28, step: 6 * HOUR },
  '1M': { points: 30, step: DAY },
  '1Y': { points: 52, step: 7 * DAY },
} as const;

export function fxRepo(bank: MockBank): FxRepo {
  return {
    async listRates() {
      const now = bank.now().getTime();
      return { data: PAIRS.map((p) => rateFor(p, now)), indicative: true };
    },
    async getRateHistory({ path, query }) {
      const { points, step } = RANGES[query.range];
      const [base] = path.pair.split('-') as [Exclude<CurrencyCode, 'NGN'>];
      rateFor(path.pair, 0);
      const end = Math.floor(bank.now().getTime() / step) * step;
      return {
        pair: path.pair,
        range: query.range,
        points: Array.from({ length: points }, (_, i) => {
          const at = end - (points - 1 - i) * step;
          return { at: new Date(at).toISOString(), rate: midRate(base, at) };
        }),
      };
    },
    async createQuote({ body }) {
      const from = bank.ownAccount(body.from_account_id);
      const to = bank.ownAccount(body.to_account_id);
      if (from.currency === to.currency)
        throw problem(422, 'validation_failed', 'Pick two different currencies');
      if (!body.sell_amount === !body.buy_amount) {
        throw problem(422, 'validation_failed', 'Give either the amount to sell or to buy');
      }
      const now = bank.now();
      const { rate, mid } = customerRate(from.currency, to.currency, now.getTime());
      // Selling a fixed amount rounds what you get down; buying a fixed amount rounds
      // what you pay up. Either way the fraction of a minor unit stays with the bank.
      const sell = body.sell_amount
        ? positive(body.sell_amount, from.currency)
        : convertAtRate(
            positive(body.buy_amount!, to.currency),
            invert(rate),
            from.currency,
            'ceil',
          );
      const buy = body.buy_amount
        ? positive(body.buy_amount, to.currency)
        : convertAtRate(sell, rate, to.currency, 'floor');
      if (buy.amount <= 0n)
        throw problem(422, 'validation_failed', 'The amount is too small to convert');
      const quote: Schema<'FxQuote'> = {
        quote_id: bank.id(),
        from_account_id: from.id,
        to_account_id: to.id,
        sell: api(sell),
        buy: api(buy),
        rate,
        mid_rate: mid,
        spread_bps: SPREAD_BPS,
        fee: api(zero(from.currency)),
        expires_at: new Date(now.getTime() + FX_QUOTE_TTL_SECONDS * 1000).toISOString(),
      };
      bank.world.fxQuotes[quote.quote_id] = quote;
      return quote;
    },
    async listConversions({ query } = {}) {
      return paginate(newestFirst(bank.world.fxConversions), query);
    },
    async convert({ body, idempotencyKey }) {
      return bank.idempotent(
        idempotencyKey,
        body,
        (id) => bank.world.fxConversions.find((c) => c.id === id),
        () => {
          const quote = bank.world.fxQuotes[body.quote_id];
          if (!quote) throw notFound('Quote');
          if (quote.expires_at < bank.nowIso()) {
            throw problem(410, 'quote_expired', 'This rate has expired. Get a fresh quote.');
          }
          const to = bank.ownAccount(quote.to_account_id);
          const debitId = bank.id();
          const creditId = bank.id();
          const sell = money(quote.sell.amount_minor, quote.sell.currency);
          const txn = (id: string, accountId: string, direction: 'debit' | 'credit') => ({
            id,
            accountId,
            direction,
            type: 'fx_conversion' as const,
            category: 'transfers' as const,
            narration: `Converted ${quote.sell.currency} to ${quote.buy.currency}`,
            counterparty: { name: 'Nem FX' },
          });
          const { buy } = convertFx(bank.ledger, {
            fromAccountId: quote.from_account_id,
            toAccountId: to.id,
            sell,
            rate: quote.rate,
            reference: bank.reference('FX'),
            idempotencyKey: `fx:${quote.quote_id}`,
            toTier: bank.tier(),
            metadata: {
              txns: [txn(debitId, quote.from_account_id, 'debit'), txn(creditId, to.id, 'credit')],
            },
          });
          const conversion: Schema<'FxConversion'> = {
            id: bank.id(),
            quote_id: quote.quote_id,
            sell: quote.sell,
            buy: api(buy),
            rate: quote.rate,
            fee: quote.fee,
            status: 'completed',
            debit_transaction_id: debitId,
            credit_transaction_id: creditId,
            created_at: bank.nowIso(),
          };
          bank.world.fxConversions.push(conversion);
          delete bank.world.fxQuotes[quote.quote_id];
          return conversion;
        },
      );
    },
    async listAlerts() {
      return { data: newestFirst(bank.world.fxAlerts) };
    },
    async createAlert({ body }) {
      rateFor(body.pair, 0);
      parseRate(body.target_rate);
      if (bank.world.fxAlerts.filter((a) => a.status === 'active').length >= 10) {
        throw problem(409, 'limit_reached', 'You can keep up to 10 rate alerts');
      }
      const alert: Schema<'FxAlert'> = {
        id: bank.id(),
        pair: body.pair,
        direction: body.direction,
        target_rate: body.target_rate,
        status: 'active',
        created_at: bank.nowIso(),
        triggered_at: null,
      };
      bank.world.fxAlerts.push(alert);
      return alert;
    },
    async deleteAlert({ path }) {
      if (!bank.world.fxAlerts.some((a) => a.id === path.alert_id)) throw notFound('Alert');
      bank.world.fxAlerts = bank.world.fxAlerts.filter((a) => a.id !== path.alert_id);
    },
  };
}
