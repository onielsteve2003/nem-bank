import type { Schema } from '@nem/contracts';
import { parseMajor } from '@nem/shared';

import { problem } from '@/data/errors';

import {
  convertErrorMessage,
  convertibleInto,
  convertProblem,
  nairaPerUnit,
  quoteDeadline,
  rateLine,
  spreadCost,
  spreadPercent,
  typedAmount,
} from '../quote';

const account = (id: string, currency: Schema<'Account'>['currency']) =>
  ({ id, currency }) as Schema<'Account'>;
const dto = (major: string, currency: 'NGN' | 'USD') => ({
  amount_minor: parseMajor(major, currency).amount.toString(),
  currency,
});

describe('convertibleInto', () => {
  const wallets = [account('n', 'NGN'), account('u', 'USD'), account('g', 'GBP')];

  it('converts naira into any foreign wallet and a foreign wallet back to naira', () => {
    expect(convertibleInto(wallets, wallets[0]!).map((a) => a.id)).toEqual(['u', 'g']);
    expect(convertibleInto(wallets, wallets[1]!).map((a) => a.id)).toEqual(['n']);
  });
});

it('reads only positive typed amounts in the wallet’s currency', () => {
  expect(typedAmount('', 'USD')).toBeNull();
  expect(typedAmount('0', 'USD')).toBeNull();
  expect(typedAmount('12.5', 'USD')).toEqual(parseMajor('12.50', 'USD'));
});

describe('rates', () => {
  it('reads a rate as naira per unit of the foreign currency, either way round', () => {
    expect(nairaPerUnit('1609.77', 'USD', 'NGN')).toEqual(parseMajor('1609.77', 'NGN'));
    // ₦→$ quotes dollars per naira; the customer still reads it as naira per dollar.
    expect(nairaPerUnit('0.00062121', 'NGN', 'USD')).toEqual(parseMajor('1609.76', 'NGN'));
    expect(rateLine('0.00049751', 'NGN', 'GBP')).toBe('£1 = ₦2,010.01');
  });

  it('prices the spread in the money the customer receives', () => {
    const quote = {
      sell: dto('100', 'USD'),
      buy: dto('157600', 'NGN'),
      rate: '1576',
      mid_rate: '1600',
      spread_bps: 150,
    } as Schema<'FxQuote'>;
    expect(spreadCost(quote)).toEqual(parseMajor('2400', 'NGN'));
    expect(spreadPercent(150)).toBe('1.5%');
    expect(spreadPercent(100)).toBe('1%');
  });
});

it('holds a quote for 60 seconds from when it arrived', () => {
  const received = Date.parse('2026-10-21T10:00:00Z');
  expect(quoteDeadline(received)).toBe('2026-10-21T10:01:00.000Z');
});

it('stops an amount above what the wallet has', () => {
  const available = parseMajor('50', 'USD');
  expect(convertProblem(parseMajor('50', 'USD'), available)).toBeNull();
  expect(convertProblem(parseMajor('50.01', 'USD'), available)).toBe(
    'More than your available $50.00.',
  );
});

describe('convertErrorMessage', () => {
  it('asks for a new rate when the quote expired', () => {
    expect(convertErrorMessage(problem(410, 'quote_expired', 'Expired'))).toEqual({
      message: 'That rate expired. Check the new rate and confirm again.',
      requote: true,
    });
  });

  it('says a retry after a lost answer is safe', () => {
    expect(convertErrorMessage(problem(504, 'gateway_timeout', 'Timed out'))).toMatchObject({
      message: expect.stringMatching(/won't convert twice/),
      requote: false,
    });
  });
});
