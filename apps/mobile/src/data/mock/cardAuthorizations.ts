import type { Schema } from '@nem/contracts';
import { money, negate, type Money } from '@nem/shared';

import { isApiError } from '../errors';
import { addDays, addMinutes } from './convert';
import type { Ledger } from './ledger';
import type { MockBank } from './runtime';
import type { CardRecord, World } from './world';

// Card payments arrive in two steps, as on a real card network (CARD-5): the
// merchant's authorisation holds the money, and settlement a little later posts it.
// An authorisation that never settles drops off when its hold expires.

export interface CardAuthorizationRecord {
  id: string;
  cardId: string;
  accountId: string;
  holdId: string;
  merchant: { name: string; mcc: string; country: string };
  category: Schema<'Category'>;
  amount: Schema<'Money'>;
  status: 'authorized' | 'settled' | 'reversed';
  authorizedAt: string;
  settlesAt: string;
  settledAt: string | null;
  transactionId: string | null;
}

/** Networks let an unsettled authorisation hold money for about a week. */
const AUTH_HOLD_DAYS = 7;

const api = (m: Money): Schema<'Money'> => ({
  amount_minor: m.amount.toString(),
  currency: m.currency,
});

export function authorizeCard(
  ledger: Ledger,
  world: World,
  newId: () => string,
  input: {
    card: CardRecord;
    merchant: CardAuthorizationRecord['merchant'];
    category: Schema<'Category'>;
    amount: Money;
    at: Date;
    settlesAt: Date;
  },
): CardAuthorizationRecord {
  const id = newId();
  const hold = ledger.placeHold({
    accountId: input.card.account_id,
    amount: input.amount,
    reason: 'card_authorization',
    reference: `AUTH-${id.slice(0, 8).toUpperCase()}`,
    expiresAt: addDays(input.at, AUTH_HOLD_DAYS).toISOString(),
  });
  const record: CardAuthorizationRecord = {
    id,
    cardId: input.card.id,
    accountId: input.card.account_id,
    holdId: hold.id,
    merchant: input.merchant,
    category: input.category,
    amount: api(input.amount),
    status: 'authorized',
    authorizedAt: input.at.toISOString(),
    settlesAt: input.settlesAt.toISOString(),
    settledAt: null,
    transactionId: null,
  };
  world.cardAuthorizations.push(record);
  return record;
}

/** The demo persona's card payments still waiting to settle: one soon, one tomorrow. */
const DEMO_AUTHORIZATIONS = [
  {
    merchant: { name: 'Bolt', mcc: '4121', country: 'NG' },
    category: 'transport',
    naira: 3_450,
    minutesAgo: 12,
    settlesInMinutes: 3,
  },
  {
    merchant: { name: 'Chicken Republic', mcc: '5812', country: 'NG' },
    category: 'food',
    naira: 6_200,
    minutesAgo: 95,
    settlesInMinutes: 24 * 60,
  },
] as const;

export function addDemoAuthorizations(
  ledger: Ledger,
  world: World,
  newId: () => string,
  now: Date,
): void {
  const card = world.cards.find((c) => c.status === 'active' && c.currency === 'NGN');
  if (!card) return;
  for (const demo of DEMO_AUTHORIZATIONS) {
    try {
      authorizeCard(ledger, world, newId, {
        card,
        merchant: demo.merchant,
        category: demo.category,
        amount: money(BigInt(demo.naira) * 100n, 'NGN'),
        at: addMinutes(now, -demo.minutesAgo),
        settlesAt: addMinutes(now, demo.settlesInMinutes),
      });
    } catch (error) {
      // Not enough available balance: a real card would have been declined.
      if (!isApiError(error)) throw error;
    }
  }
}

/** Tick task: settles authorisations that are due; marks expired ones reversed. */
export function processCardSettlements(bank: MockBank): boolean {
  let changed = false;
  for (const auth of bank.world.cardAuthorizations) {
    if (auth.status !== 'authorized') continue;
    const hold = bank.ledger.state.holds[auth.holdId];
    if (!hold || hold.status !== 'active') {
      auth.status = 'reversed';
      changed = true;
      continue;
    }
    if (auth.settlesAt > bank.nowIso()) continue;
    const amount = hold.amount;
    const transactionId = bank.id();
    bank.ledger.post({
      kind: 'card_settlement',
      reference: bank.reference(),
      idempotencyKey: `settle-${auth.id}`,
      captureHoldIds: [hold.id],
      postings: [
        { accountId: auth.accountId, amount: negate(amount) },
        {
          accountId: bank.ledger.systemAccount('card_settlement', amount.currency).id,
          amount,
        },
      ],
      metadata: {
        txns: [
          {
            id: transactionId,
            accountId: auth.accountId,
            type: 'card_payment',
            direction: 'debit',
            category: auth.category,
            narration: auth.merchant.name,
            counterparty: { name: auth.merchant.name, merchant_id: null },
            cardId: auth.cardId,
          },
        ],
      },
    });
    auth.status = 'settled';
    auth.settledAt = bank.nowIso();
    auth.transactionId = transactionId;
    changed = true;
  }
  return changed;
}
