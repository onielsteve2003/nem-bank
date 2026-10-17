import { money, type CurrencyCode, type Money } from '@nem/shared';

import { isApiError } from '../../../errors';
import { createIdFactory, seededRandom } from '../../ids';
import {
  convertFx,
  demoFund,
  emptyLedgerState,
  failExternalTransfer,
  Ledger,
  receiveExternal,
  reverseEntry,
  settleExternalTransfer,
  spentToday,
  startExternalTransfer,
  transferInternal,
} from '../index';

const ngn = (major: number) => money(BigInt(major) * 100n, 'NGN');
const usd = (major: number) => money(BigInt(major) * 100n, 'USD');

function setup(start = '2026-10-17T09:00:00.000Z') {
  let clock = new Date(start);
  const now = () => clock;
  const ledger = new Ledger(emptyLedgerState(), {
    now,
    newId: createIdFactory(now, seededRandom(7)),
  });
  const open = (currency: CurrencyCode = 'NGN') =>
    ledger.openAccount({ ownerType: 'customer', ownerId: 'u1', kind: 'customer_current', currency })
      .id;
  const fund = (accountId: string, amount: Money, key = `fund-${accountId}-${amount.amount}`) =>
    demoFund(ledger, { toAccountId: accountId, amount, tier: 3, idempotencyKey: key });
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  return { ledger, open, fund, advance };
}

const limits = { tier: 3 as const };

function expectBooksBalance(ledger: Ledger) {
  for (const total of ledger.trialBalance().values()) expect(total.amount).toBe(0n);
  for (const entry of ledger.state.entries) {
    const perCurrency = new Map<string, bigint>();
    for (const p of entry.postings) {
      perCurrency.set(
        p.amount.currency,
        (perCurrency.get(p.amount.currency) ?? 0n) + p.amount.amount,
      );
    }
    for (const sum of perCurrency.values()) expect(sum).toBe(0n);
  }
}

async function problemCode(fn: () => unknown): Promise<string | undefined> {
  try {
    await fn();
  } catch (error) {
    return isApiError(error) ? error.code : (error as Error).message;
  }
  return undefined;
}

describe('posting engine', () => {
  it('rejects an entry that does not balance', async () => {
    const { ledger, open } = setup();
    const a = open();
    const b = open();
    expect(
      await problemCode(() =>
        ledger.post({
          kind: 'manual_adjustment',
          reference: 'bad',
          postings: [
            { accountId: a, amount: ngn(-10) },
            { accountId: b, amount: ngn(9) },
          ],
        }),
      ),
    ).toMatch(/does not balance/);
    expect(ledger.state.entries).toHaveLength(0);
  });

  it('rejects a posting in the wrong currency for its account', async () => {
    const { ledger, open } = setup();
    const a = open('NGN');
    const b = open('USD');
    expect(
      await problemCode(() =>
        ledger.post({
          kind: 'manual_adjustment',
          reference: 'mixed',
          postings: [
            { accountId: a, amount: usd(-1) },
            { accountId: b, amount: usd(1) },
          ],
        }),
      ),
    ).toBe('currency_mismatch');
  });

  it('never lets a customer account go below zero, and changes nothing on failure', async () => {
    const { ledger, open, fund } = setup();
    const a = open();
    const b = open();
    fund(a, ngn(1_000));
    const before = structuredClone(ledger.state);
    expect(
      await problemCode(() =>
        transferInternal(ledger, {
          fromAccountId: a,
          toAccountId: b,
          recipientTier: 3,
          amount: ngn(1_001),
          reference: 'too-much',
          idempotencyKey: 'k1',
          limits,
        }),
      ),
    ).toBe('insufficient_funds');
    expect(ledger.state).toEqual(before);
  });

  it('replays the same idempotency key and rejects it with a different body', async () => {
    const { ledger, open, fund } = setup();
    const a = open();
    const b = open();
    fund(a, ngn(5_000));
    const send = (amount: Money) =>
      transferInternal(ledger, {
        fromAccountId: a,
        toAccountId: b,
        recipientTier: 3,
        amount,
        reference: 'rent',
        idempotencyKey: 'same-key',
        limits,
      });
    const first = send(ngn(1_000));
    expect(send(ngn(1_000))).toBe(first);
    expect(ledger.account(a).balance).toEqual(ngn(4_000));
    expect(await problemCode(() => send(ngn(2_000)))).toBe('idempotency_conflict');
  });

  it('blocks debits from a frozen account but still accepts credits', async () => {
    const { ledger, open, fund } = setup();
    const a = open();
    const b = open();
    fund(a, ngn(100));
    ledger.setStatus(a, 'frozen');
    fund(a, ngn(50), 'second');
    expect(ledger.account(a).balance).toEqual(ngn(150));
    expect(
      await problemCode(() =>
        transferInternal(ledger, {
          fromAccountId: a,
          toAccountId: b,
          recipientTier: 3,
          amount: ngn(10),
          reference: 'x',
          idempotencyKey: 'k',
          limits,
        }),
      ),
    ).toBe('account_frozen');
  });
});

describe('holds', () => {
  it('reduce the available balance but not the ledger balance', () => {
    const { ledger, open, fund } = setup();
    const a = open();
    fund(a, ngn(1_000));
    const hold = ledger.placeHold({
      accountId: a,
      amount: ngn(400),
      reason: 'card_authorization',
      reference: 'pos',
    });
    expect(ledger.account(a).balance).toEqual(ngn(1_000));
    expect(ledger.available(a)).toEqual(ngn(600));
    ledger.releaseHold(hold.id);
    expect(ledger.available(a)).toEqual(ngn(1_000));
  });

  it('cannot hold more than is available', async () => {
    const { ledger, open, fund } = setup();
    const a = open();
    fund(a, ngn(100));
    ledger.placeHold({ accountId: a, amount: ngn(80), reason: 'dispute', reference: 'd' });
    expect(
      await problemCode(() =>
        ledger.placeHold({ accountId: a, amount: ngn(21), reason: 'dispute', reference: 'd2' }),
      ),
    ).toBe('insufficient_funds');
  });

  it('expire on time', () => {
    const { ledger, open, fund, advance } = setup();
    const a = open();
    fund(a, ngn(100));
    ledger.placeHold({
      accountId: a,
      amount: ngn(50),
      reason: 'card_authorization',
      reference: 'auth',
      expiresAt: '2026-10-17T10:00:00.000Z',
    });
    expect(ledger.expireHolds()).toHaveLength(0);
    advance(60 * 60 * 1000);
    expect(ledger.expireHolds()).toHaveLength(1);
    expect(ledger.available(a)).toEqual(ngn(100));
  });
});

describe('external transfers', () => {
  it('hold amount plus fee, then settle to the partner and fee income', () => {
    const { ledger, open, fund } = setup();
    const a = open();
    fund(a, ngn(20_000));
    const hold = startExternalTransfer(ledger, {
      fromAccountId: a,
      amount: ngn(10_000),
      reference: 'nip-1',
      idempotencyKey: 'ext-1',
      limits,
    });
    // ₦10,000 is in the ₦5,001–₦50,000 band: ₦25 fee.
    expect(hold.amount).toEqual(ngn(10_025));
    expect(ledger.available(a)).toEqual(ngn(9_975));

    const entry = settleExternalTransfer(ledger, hold.id, 'settle-1');
    expect(settleExternalTransfer(ledger, hold.id, 'settle-1')).toBe(entry);
    expect(ledger.account(a).balance).toEqual(ngn(9_975));
    expect(ledger.available(a)).toEqual(ngn(9_975));
    expect(ledger.systemAccount('fee_income', 'NGN').balance).toEqual(ngn(25));
    expectBooksBalance(ledger);
  });

  it('return the held funds when the partner fails, and reversals refund in full', () => {
    const { ledger, open, fund } = setup();
    const a = open();
    fund(a, ngn(1_000));
    const hold = startExternalTransfer(ledger, {
      fromAccountId: a,
      amount: ngn(500),
      reference: 'nip-2',
      idempotencyKey: 'ext-2',
      limits,
    });
    failExternalTransfer(ledger, hold.id);
    expect(ledger.available(a)).toEqual(ngn(1_000));

    const second = startExternalTransfer(ledger, {
      fromAccountId: a,
      amount: ngn(500),
      reference: 'nip-3',
      idempotencyKey: 'ext-3',
      limits,
    });
    const settled = settleExternalTransfer(ledger, second.id, 'settle-3');
    reverseEntry(ledger, settled.id, 'reverse-3');
    expect(ledger.account(a).balance).toEqual(ngn(1_000));
    expectBooksBalance(ledger);
  });
});

describe('limits', () => {
  it('enforces the KYC daily limit across settled and pending transfers', async () => {
    const { ledger, open, fund } = setup();
    const a = open();
    const b = open();
    fund(a, ngn(200_000));
    const tier1 = { tier: 1 as const };
    transferInternal(ledger, {
      fromAccountId: a,
      toAccountId: b,
      recipientTier: 3,
      amount: ngn(30_000),
      reference: 'one',
      idempotencyKey: 'l1',
      limits: tier1,
    });
    startExternalTransfer(ledger, {
      fromAccountId: a,
      amount: ngn(15_000),
      reference: 'two',
      idempotencyKey: 'l2',
      limits: tier1,
    });
    expect(spentToday(ledger, a, ledger.now().toISOString())).toEqual(ngn(45_000));
    expect(
      await problemCode(() =>
        transferInternal(ledger, {
          fromAccountId: a,
          toAccountId: b,
          recipientTier: 3,
          amount: ngn(5_001),
          reference: 'three',
          idempotencyKey: 'l3',
          limits: tier1,
        }),
      ),
    ).toBe('limit_exceeded');
  });

  it('applies a lower self-set limit and resets at midnight in Lagos', async () => {
    // 22:30 UTC is 23:30 in Lagos; 23:30 UTC is already the next day there.
    const { ledger, open, fund, advance } = setup('2026-10-17T22:30:00.000Z');
    const a = open();
    const b = open();
    fund(a, ngn(10_000));
    const send = (amount: Money, key: string) =>
      transferInternal(ledger, {
        fromAccountId: a,
        toAccountId: b,
        recipientTier: 3,
        amount,
        reference: key,
        idempotencyKey: key,
        limits: { tier: 3, selfDailyLimit: ngn(1_000) },
      });
    send(ngn(1_000), 's1');
    expect(await problemCode(() => send(ngn(1), 's2'))).toBe('limit_exceeded');
    advance(60 * 60 * 1000);
    expect(send(ngn(1_000), 's3').kind).toBe('transfer_internal');
  });

  it('enforces the Tier 1 maximum balance on incoming money', async () => {
    const { ledger, open } = setup();
    const a = open();
    expect(
      await problemCode(() =>
        receiveExternal(ledger, {
          toAccountId: a,
          amount: ngn(300_001),
          tier: 1,
          reference: 'big',
          idempotencyKey: 'in-1',
        }),
      ),
    ).toBe('max_balance_exceeded');
  });
});

describe('incoming transfers', () => {
  it('take the ₦50 EMTL levy from inflows of ₦10,000 or more in the same entry', () => {
    const { ledger, open } = setup();
    const a = open();
    receiveExternal(ledger, {
      toAccountId: a,
      amount: ngn(9_999),
      tier: 3,
      reference: 'r1',
      idempotencyKey: 'i1',
    });
    receiveExternal(ledger, {
      toAccountId: a,
      amount: ngn(10_000),
      tier: 3,
      reference: 'r2',
      idempotencyKey: 'i2',
    });
    expect(ledger.account(a).balance).toEqual(ngn(19_949));
    expect(ledger.systemAccount('levy_payable', 'NGN').balance).toEqual(ngn(50));
    expectBooksBalance(ledger);
  });
});

describe('FX conversions', () => {
  it('balance each currency through its own position account', () => {
    const { ledger, open, fund } = setup();
    const naira = open('NGN');
    const dollars = open('USD');
    fund(naira, ngn(157_600));
    const { buy } = convertFx(ledger, {
      fromAccountId: naira,
      toAccountId: dollars,
      sell: ngn(157_600),
      rate: '0.00063451',
      reference: 'fx-1',
      idempotencyKey: 'fx-1',
      toTier: 3,
    });
    // 15,760,000 kobo × 0.00063451 = 9,999.88 cents, rounded down.
    expect(buy).toEqual(money(9_999n, 'USD'));
    expect(ledger.account(dollars).balance).toEqual(buy);
    expect(ledger.systemAccount('fx_position', 'NGN').balance).toEqual(ngn(157_600));
    expect(ledger.systemAccount('fx_position', 'USD').balance).toEqual(money(-9_999n, 'USD'));
    expectBooksBalance(ledger);
  });
});

describe('invariants under random activity', () => {
  it('keeps every currency at zero and every customer balance non-negative', () => {
    const { ledger, open, fund } = setup();
    const random = seededRandom(42);
    const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]!;
    const naira = [open(), open(), open()];
    const dollars = [open('USD'), open('USD')];
    naira.forEach((id) => fund(id, ngn(100_000)));
    const holds: string[] = [];

    for (let i = 0; i < 400; i++) {
      const amount = ngn(1 + Math.floor(random() * 40_000));
      const key = `op-${i}`;
      const action = Math.floor(random() * 6);
      try {
        if (action === 0) {
          const [from, to] = [pick(naira), pick(naira)];
          if (from !== to) {
            transferInternal(ledger, {
              fromAccountId: from,
              toAccountId: to,
              recipientTier: 3,
              amount,
              reference: key,
              idempotencyKey: key,
              limits,
            });
          }
        } else if (action === 1) {
          holds.push(
            startExternalTransfer(ledger, {
              fromAccountId: pick(naira),
              amount,
              reference: key,
              idempotencyKey: key,
              limits,
            }).id,
          );
        } else if (action === 2 && holds.length) {
          const hold = holds.splice(Math.floor(random() * holds.length), 1)[0]!;
          if (random() < 0.7) settleExternalTransfer(ledger, hold, key);
          else failExternalTransfer(ledger, hold);
        } else if (action === 3) {
          receiveExternal(ledger, {
            toAccountId: pick(naira),
            amount,
            tier: 3,
            reference: key,
            idempotencyKey: key,
          });
        } else if (action === 4) {
          convertFx(ledger, {
            fromAccountId: pick(naira),
            toAccountId: pick(dollars),
            sell: amount,
            rate: '0.00062',
            reference: key,
            idempotencyKey: key,
            toTier: 3,
          });
        } else if (action === 5) {
          const usdBalance = pick(dollars);
          convertFx(ledger, {
            fromAccountId: usdBalance,
            toAccountId: pick(naira),
            sell: usd(1 + Math.floor(random() * 30)),
            rate: '1590.5',
            reference: key,
            idempotencyKey: key,
            toTier: 3,
          });
        }
      } catch (error) {
        // Business-rule rejections are expected; anything else is a bug.
        expect(isApiError(error)).toBe(true);
      }

      for (const id of [...naira, ...dollars]) {
        expect(ledger.available(id).amount >= 0n).toBe(true);
      }
    }
    expectBooksBalance(ledger);
    expect(ledger.state.entries.length).toBeGreaterThan(100);
  });
});
