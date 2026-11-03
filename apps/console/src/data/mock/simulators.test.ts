import { describe, expect, it } from 'vitest';

import { isApiError } from '../errors';
import { repositoriesFromDispatcher } from '../repositories';
import { switchDemoRole } from './auth';
import { createMockDispatcher } from './index';
import { systemAccountId } from './ledgerSeed';
import { createMockState, type MockState } from './state';

function setup() {
  const state = createMockState();
  const { access_token } = switchDemoRole(state, 'admin');
  const repos = repositoriesFromDispatcher(
    createMockDispatcher({ latencyMs: 0, state, getAccessToken: () => access_token }),
  );
  return { state, repos };
}

const is = (code: string) => (e: unknown) => isApiError(e, code);
let key = 0;
const nextKey = () => `sim-${++key}`;

const SHOPRITE = { id: 'shoprite-lekki', name: 'Shoprite Lekki', mcc: '5411', country: 'NG' };
const NETFLIX = { id: 'netflix', name: 'Netflix', mcc: '4899', country: 'US' };
const naira = (major: number) => ({ amount_minor: String(major * 100), currency: 'NGN' as const });

function chargeBody(state: MockState, cardIndex: number, overrides: object = {}) {
  const { pan, cvv, card } = state.simulators.cards[cardIndex]!;
  return {
    pan,
    cvv,
    expiry_month: card.expiry_month,
    expiry_year: card.expiry_year,
    amount: naira(10_000),
    merchant: SHOPRITE,
    channel: 'online' as const,
    capture: false,
    ...overrides,
  };
}

const available = (state: MockState, accountId: string) =>
  BigInt(state.ledger.accounts.get(accountId)!.available.amount_minor);
const balance = (state: MockState, accountId: string) =>
  BigInt(state.ledger.accounts.get(accountId)!.balance.amount_minor);

describe('merchant simulator', () => {
  it('holds on authorization, then settles into the ledger on capture', async () => {
    const { state, repos } = setup();
    const accountId = state.simulators.cards[0]!.card.account_id;
    const startBalance = balance(state, accountId);
    const settlement = systemAccountId('card_settlement', 'NGN');
    const startSettlement = balance(state, settlement);

    const tx = await repos.simulators.charge({
      body: chargeBody(state, 0),
      idempotencyKey: nextKey(),
    });
    expect(tx).toMatchObject({ status: 'authorized', decline_reason: null });
    expect(available(state, accountId)).toBe(startBalance - 1_000_000n);
    expect(balance(state, accountId)).toBe(startBalance);

    // A smaller final bill settles only that much and releases the rest of the hold.
    const settled = await repos.simulators.capture({
      path: { authorization_id: tx.id },
      body: { amount: naira(8_000) },
      idempotencyKey: nextKey(),
    });
    expect(settled).toMatchObject({ status: 'settled', billing_amount: naira(8_000) });
    expect(balance(state, accountId)).toBe(startBalance - 800_000n);
    expect(available(state, accountId)).toBe(startBalance - 800_000n);
    expect(balance(state, settlement)).toBe(startSettlement + 800_000n);
    expect(state.ledger.entries.at(-1)).toMatchObject({ kind: 'card_settlement' });

    await expect(
      repos.simulators.reverse({ path: { authorization_id: tx.id }, idempotencyKey: nextKey() }),
    ).rejects.toSatisfy(is('conflict'));
  });

  it('releases the hold on reversal and logs the outcome without card details', async () => {
    const { state, repos } = setup();
    const accountId = state.simulators.cards[0]!.card.account_id;
    const start = available(state, accountId);
    const tx = await repos.simulators.charge({
      body: chargeBody(state, 0),
      idempotencyKey: nextKey(),
    });
    await repos.simulators.reverse({
      path: { authorization_id: tx.id },
      idempotencyKey: nextKey(),
    });
    expect(available(state, accountId)).toBe(start);
    const charged = state.audit.find((e) => e.action === 'simulator.card.charge')!;
    expect(charged.metadata).toEqual({ status: 'authorized', decline_reason: null });
    expect(JSON.stringify(state.audit)).not.toContain(state.simulators.cards[0]!.pan);
  });

  it('converts a dollar charge at mid plus the configured spread', async () => {
    const { state, repos } = setup();
    const tx = await repos.simulators.charge({
      body: chargeBody(state, 0, {
        merchant: NETFLIX,
        amount: { amount_minor: '1000', currency: 'USD' },
      }),
      idempotencyKey: nextKey(),
    });
    // $10 × ₦1,600 × 1.015 = ₦16,240
    expect(tx.billing_amount).toEqual(naira(16_240));
  });

  it.each([
    [2, { merchant: NETFLIX }, 'international_disabled'],
    [3, {}, 'card_frozen'],
    [5, {}, 'merchant_not_allowed'],
    [0, { amount: naira(600_000) }, 'limit_exceeded'],
    [4, { amount: naira(1_000_000) }, 'insufficient_funds'],
  ])('declines card %i with %o as %s', async (card, overrides, reason) => {
    const { state, repos } = setup();
    const tx = await repos.simulators.charge({
      body: chargeBody(state, card, overrides),
      idempotencyKey: nextKey(),
    });
    expect(tx).toMatchObject({ status: 'declined', decline_reason: reason });
  });

  it('uses up a single-use card on its first approval', async () => {
    const { state, repos } = setup();
    const first = await repos.simulators.charge({
      body: chargeBody(state, 4, { amount: naira(1_000) }),
      idempotencyKey: nextKey(),
    });
    expect(first.status).toBe('authorized');
    const second = await repos.simulators.charge({
      body: chargeBody(state, 4, { amount: naira(1_000) }),
      idempotencyKey: nextKey(),
    });
    expect(second.decline_reason).toBe('card_used');
  });

  it('refuses details that match no card', async () => {
    const { state, repos } = setup();
    await expect(
      repos.simulators.charge({
        body: chargeBody(state, 0, { cvv: '999' }),
        idempotencyKey: nextKey(),
      }),
    ).rejects.toSatisfy(is('validation_failed'));
  });
});

describe('bank partner simulator', () => {
  it('saves valid settings and refuses a longest delay below the shortest', async () => {
    const { repos } = setup();
    const current = await repos.simulators.getBankPartner();
    const next = { ...current, failure_rate_bps: 1_000, min_delay_seconds: 5 };
    await expect(repos.simulators.setBankPartner({ body: next })).resolves.toEqual(next);
    await expect(repos.simulators.getBankPartner()).resolves.toEqual(next);
    await expect(
      repos.simulators.setBankPartner({ body: { ...next, max_delay_seconds: 2 } }),
    ).rejects.toSatisfy(is('validation_failed'));
  });
});
