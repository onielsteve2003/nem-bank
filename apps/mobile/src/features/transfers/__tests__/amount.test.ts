import type { Schema } from '@nem/contracts';
import { parseMajor } from '@nem/shared';

import { amountProblem, coolingOffNotice, typedNaira } from '../amount';

const ngn = (major: string) => parseMajor(major, 'NGN');
const dto = (major: string) => ({
  amount_minor: ngn(major).amount.toString(),
  currency: 'NGN' as const,
});

const quote = (over: Partial<Schema<'TransferQuote'>> & { remaining?: string } = {}) =>
  ({
    quote_id: 'q',
    amount: dto('6000'),
    fee: dto('25'),
    fees: [],
    total_debit: dto('6025'),
    limits: {
      kyc_tier: 1,
      daily_limit: dto('50000'),
      used_today: dto('0'),
      remaining_today: dto(over.remaining ?? '50000'),
      self_set: false,
      cool_off_active: false,
    },
    cooling_off: null,
    rail: 'interbank',
    expires_at: '2026-10-20T12:00:00Z',
    ...over,
  }) as Schema<'TransferQuote'>;

it('reads only positive typed amounts', () => {
  expect(typedNaira('')).toBeNull();
  expect(typedNaira('0')).toBeNull();
  expect(typedNaira('0.')).toBeNull();
  expect(typedNaira('1500.5')).toEqual(ngn('1500.50'));
});

describe('amountProblem', () => {
  const base = { amount: ngn('6000'), available: ngn('10000'), singleLimit: null, quote: quote() };

  it('allows an amount within the balance and limits, fee included', () => {
    expect(amountProblem(base)).toBeNull();
  });

  it('enforces the customer’s own single-transfer limit first', () => {
    expect(amountProblem({ ...base, singleLimit: ngn('5000') })).toBe(
      'Above your own limit of ₦5,000.00 per transfer.',
    );
  });

  it('catches an amount above the balance before the bank answers', () => {
    expect(amountProblem({ ...base, amount: ngn('20000'), quote: null })).toMatch(
      /More than your available/,
    );
  });

  it('names what is left of the daily limit for the KYC tier', () => {
    expect(amountProblem({ ...base, quote: quote({ remaining: '4000' }) })).toBe(
      'You can send ₦4,000.00 more today on Tier 1.',
    );
    expect(amountProblem({ ...base, quote: quote({ remaining: '0' }) })).toMatch(/reached today/);
  });

  it('counts the fee against the balance', () => {
    expect(amountProblem({ ...base, available: ngn('6010') })).toBe(
      'You need ₦6,025.00 including the ₦25.00 fee.',
    );
  });
});

it('explains new-beneficiary cooling-off and new-device step-up', () => {
  expect(coolingOffNotice(quote())).toBeNull();
  expect(
    coolingOffNotice(
      quote({
        cooling_off: { reason: 'new_beneficiary', delay_minutes: 30, step_up_skips_delay: true },
      }),
    ),
  ).toMatch(/goes out in 30 minutes, or straight away/);
  expect(
    coolingOffNotice(
      quote({ cooling_off: { reason: 'new_device', delay_minutes: 0, step_up_skips_delay: true } }),
    ),
  ).toMatch(/signed in on this phone recently/);
});
