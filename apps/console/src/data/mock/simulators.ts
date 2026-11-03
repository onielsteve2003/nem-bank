import type { Schema } from '@nem/contracts';
import { divideRounded, type CurrencyCode } from '@nem/shared';

import { problem } from '../errors';
import { findCustomer } from './customers';
import type { Handlers } from './handlers';
import { post, systemAccountId } from './ledgerSeed';
import type { SimCard, SimCharge } from './simulatorSeed';
import { newId, type MockState } from './state';

type CardTransaction = Schema<'CardTransaction'>;
type Decline = NonNullable<CardTransaction['decline_reason']>;
type Money = Schema<'Money'>;

/** Mid-market naira per dollar in the sandbox; the bank's spread comes from config. */
const USD_NGN_MID = 1_600n;

const money = (amount: bigint, currency: CurrencyCode): Money => ({
  amount_minor: amount.toString(),
  currency,
});

function invalid(field: string, title: string, message: string): never {
  throw problem(422, 'validation_failed', title, { errors: [{ field, code: 'invalid', message }] });
}

/** The amount in the card's currency, at mid plus the bank's spread, rounded in the bank's favour. */
function billingAmount(state: MockState, amount: Money, card: CurrencyCode): bigint {
  const minor = BigInt(amount.amount_minor);
  if (amount.currency === card) return minor;
  const spread = BigInt(state.config.fx_spreads_bps['USD-NGN'] ?? 0);
  if (amount.currency === 'USD' && card === 'NGN') {
    return divideRounded(minor * USD_NGN_MID * (10_000n + spread), 10_000n, 'ceil');
  }
  if (amount.currency === 'NGN' && card === 'USD') {
    return divideRounded(minor * 10_000n, USD_NGN_MID * (10_000n - spread), 'ceil');
  }
  invalid('/amount/currency', 'Charge in naira or dollars', 'Use NGN or USD.');
}

/** Available = ledger balance less every open authorization on the account. */
function syncAvailable(state: MockState, userId: string, accountId: string) {
  const holds = [...state.simulators.charges.values()]
    .filter((c) => c.accountId === accountId && c.tx.status === 'authorized')
    .reduce((sum, c) => sum + c.hold, 0n);
  const ledgerAccount = state.ledger.accounts.get(accountId);
  const view = findCustomer(state, userId).view.accounts.find((a) => a.id === accountId);
  if (!ledgerAccount || !view) return;
  const balance = BigInt(ledgerAccount.balance.amount_minor);
  ledgerAccount.available = money(balance - holds, ledgerAccount.currency);
  view.ledger_balance = ledgerAccount.balance;
  view.available_balance = ledgerAccount.available;
}

/** The checks the card processor runs, in its order; the first that fails names the decline. */
function declineReason(
  state: MockState,
  sim: SimCard,
  body: Schema<'SimulatedChargeRequest'>,
  billing: bigint,
): Decline | null {
  const { card } = sim;
  const customer = findCustomer(state, sim.userId).view.customer;
  if (card.status === 'used') return 'card_used';
  if (card.status === 'frozen' || customer.status !== 'active') return 'card_frozen';
  if (body.channel === 'online' && !card.controls.online_enabled) return 'online_disabled';
  if (body.merchant.country !== 'NG' && !card.controls.international_enabled) {
    return 'international_disabled';
  }
  const lock = card.controls.merchant_lock;
  if (lock && lock.merchant_id !== body.merchant.id) return 'merchant_not_allowed';
  const limit = card.controls.spend_limit;
  if (limit?.period === 'per_transaction' && billing > BigInt(limit.amount.amount_minor)) {
    return 'limit_exceeded';
  }
  const available = state.ledger.accounts.get(card.account_id)?.available;
  if (!available || billing > BigInt(available.amount_minor)) return 'insufficient_funds';
  return null;
}

function findCharge(state: MockState, id: string): SimCharge {
  const found = state.simulators.charges.get(id);
  if (!found) throw problem(404, 'not_found', 'No authorization with that ID');
  return found;
}

const userOf = (state: MockState, charge: SimCharge) =>
  state.simulators.cards.find((c) => c.card.id === charge.tx.card_id)!.userId;

/** Turns the hold into a ledger posting, and the customer sees a card payment. */
function settle(state: MockState, charge: SimCharge, amount: Money) {
  const { tx } = charge;
  const captured = BigInt(amount.amount_minor);
  // A smaller final bill settles the same share of what was held.
  const billing = divideRounded(charge.hold * captured, BigInt(tx.amount.amount_minor), 'ceil');
  const currency = tx.billing_amount.currency;
  const at = new Date(state.now()).toISOString();
  const reference = `NEMCRD${tx.id.replaceAll('-', '').slice(-10).toUpperCase()}`;
  tx.status = 'settled';
  tx.settled_at = at;
  tx.amount = amount;
  tx.billing_amount = money(billing, currency);
  tx.transaction_id = newId();
  post(state.ledger, {
    kind: 'card_settlement',
    reference,
    at,
    postings: [
      [charge.accountId, -billing],
      [systemAccountId('card_settlement', currency), billing],
    ],
    metadata: { authorization_id: tx.id, merchant_mcc: tx.merchant.mcc, scheme: 'simulator' },
  });
  const userId = userOf(state, charge);
  syncAvailable(state, userId, charge.accountId);
  const record = findCustomer(state, userId);
  const account = record.view.accounts.find((a) => a.id === charge.accountId);
  const payment: Schema<'Transaction'> = {
    id: tx.transaction_id,
    account_id: charge.accountId,
    type: 'card_payment',
    direction: 'debit',
    status: 'completed',
    amount: tx.billing_amount,
    fee: null,
    balance_after: account?.ledger_balance ?? null,
    narration: tx.merchant.name,
    reference,
    category: 'shopping',
    category_source: 'rules',
    counterparty: { name: tx.merchant.name },
    transfer_id: null,
    card_id: tx.card_id,
    created_at: at,
  };
  record.view.recent_transactions = [payment, ...record.view.recent_transactions].slice(0, 20);
}

export const simulatorHandlers: Handlers = {
  simulateCardCharge: ({ body, idempotencyKey }, { state }) => {
    const replay = state.idempotency.get(idempotencyKey);
    if (replay) return structuredClone(replay as CardTransaction);

    const sim = state.simulators.cards.find(
      (c) =>
        c.pan === body.pan &&
        c.cvv === body.cvv &&
        c.card.expiry_month === body.expiry_month &&
        c.card.expiry_year === body.expiry_year,
    );
    if (!sim) {
      invalid('/pan', 'No card matches those details', 'Check the number, expiry and CVV.');
    }
    if (!/^\d+$/.test(String(body.amount.amount_minor)) || BigInt(body.amount.amount_minor) <= 0n) {
      invalid('/amount', 'Enter an amount above zero', 'Above zero.');
    }

    const { card } = sim;
    const billing = billingAmount(state, body.amount, card.currency);
    const decline = declineReason(state, sim, body, billing);
    const at = new Date(state.now()).toISOString();
    const tx: CardTransaction = {
      id: newId(),
      card_id: card.id,
      merchant: body.merchant,
      amount: body.amount,
      billing_amount: money(billing, card.currency),
      status: decline ? 'declined' : 'authorized',
      decline_reason: decline,
      transaction_id: null,
      authorized_at: at,
      settled_at: null,
    };
    const charge: SimCharge = { tx, accountId: card.account_id, hold: decline ? 0n : billing };
    state.simulators.charges.set(tx.id, charge);
    if (!decline) {
      if (card.type === 'single_use') card.status = 'used';
      syncAvailable(state, sim.userId, card.account_id);
      if (body.capture) settle(state, charge, body.amount);
    }
    state.idempotency.set(idempotencyKey, structuredClone(tx));
    return structuredClone(tx);
  },

  captureSimulatedCharge: ({ path, body, idempotencyKey }, { state }) => {
    const replay = state.idempotency.get(idempotencyKey);
    if (replay) return structuredClone(replay as CardTransaction);
    const charge = findCharge(state, path.authorization_id);
    if (charge.tx.status !== 'authorized') {
      throw problem(409, 'conflict', `This charge is ${charge.tx.status}, not waiting to settle`);
    }
    const amount = body?.amount ?? charge.tx.amount;
    const captured = BigInt(amount.amount_minor);
    if (
      amount.currency !== charge.tx.amount.currency ||
      captured <= 0n ||
      captured > BigInt(charge.tx.amount.amount_minor)
    ) {
      invalid(
        '/amount',
        'Capture at most what was authorized',
        `Above zero, up to the authorized amount in ${charge.tx.amount.currency}.`,
      );
    }
    settle(state, charge, amount);
    state.idempotency.set(idempotencyKey, structuredClone(charge.tx));
    return structuredClone(charge.tx);
  },

  reverseSimulatedCharge: ({ path, idempotencyKey }, { state }) => {
    const replay = state.idempotency.get(idempotencyKey);
    if (replay) return structuredClone(replay as CardTransaction);
    const charge = findCharge(state, path.authorization_id);
    if (charge.tx.status !== 'authorized') {
      throw problem(
        409,
        'conflict',
        `This charge is ${charge.tx.status}; only a hold can be reversed`,
        {
          detail:
            charge.tx.status === 'settled'
              ? 'A settled charge comes back through a dispute.'
              : undefined,
        },
      );
    }
    charge.tx.status = 'reversed';
    syncAvailable(state, userOf(state, charge), charge.accountId);
    state.idempotency.set(idempotencyKey, structuredClone(charge.tx));
    return structuredClone(charge.tx);
  },

  getBankPartnerSimulator: (_input, { state }) => structuredClone(state.simulators.bankPartner),

  setBankPartnerSimulator: ({ body }, { state }) => {
    const bps = (v: number | undefined, field: string) => {
      if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > 10_000)) {
        invalid(field, 'Use 0 to 10,000 basis points', 'A whole number from 0 to 10,000.');
      }
    };
    bps(body.failure_rate_bps, '/failure_rate_bps');
    bps(body.timeout_rate_bps, '/timeout_rate_bps');
    const delay = (v: number, max: number, field: string) => {
      if (!Number.isInteger(v) || v < 0 || v > max) {
        invalid(field, 'Check the delay', `A whole number of seconds from 0 to ${max}.`);
      }
    };
    delay(body.min_delay_seconds, 300, '/min_delay_seconds');
    delay(body.max_delay_seconds, 600, '/max_delay_seconds');
    if (body.min_delay_seconds > body.max_delay_seconds) {
      invalid('/max_delay_seconds', 'Check the delay', 'At least the shortest delay.');
    }
    if ((body.failure_rate_bps ?? 0) + (body.timeout_rate_bps ?? 0) > 10_000) {
      invalid(
        '/timeout_rate_bps',
        'Failures and timeouts add up to more than every transfer',
        'Together at most 10,000.',
      );
    }
    state.simulators.bankPartner = structuredClone(body);
    return structuredClone(body);
  },
};
