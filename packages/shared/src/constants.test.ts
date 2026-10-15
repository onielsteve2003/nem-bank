import { emtlFor, KYC_TIERS, transferFee } from './constants';
import { parseMajor } from './money';

const ngn = (major: string) => parseMajor(major, 'NGN');

describe('transferFee', () => {
  it('is free between Nem users', () => {
    expect(transferFee(ngn('1000000'), 'internal').amount).toBe(0n);
  });

  it.each([
    ['5000', '10'],
    ['5000.01', '25'],
    ['50000', '25'],
    ['50000.01', '50'],
  ])('charges ₦%s external a fee of ₦%s', (amount, fee) => {
    expect(transferFee(ngn(amount), 'external')).toEqual(ngn(fee));
  });

  it('only prices NGN', () => {
    expect(() => transferFee(parseMajor('10', 'USD'), 'external')).toThrow(RangeError);
  });
});

describe('emtlFor', () => {
  it('levies ₦50 on NGN inflows from ₦10,000', () => {
    expect(emtlFor(ngn('9999.99')).amount).toBe(0n);
    expect(emtlFor(ngn('10000'))).toEqual(ngn('50'));
    expect(emtlFor(parseMajor('20000', 'USD')).amount).toBe(0n);
  });
});

describe('KYC_TIERS', () => {
  it('raises limits with each tier', () => {
    expect(KYC_TIERS[1].dailyLimit).toEqual(ngn('50000'));
    expect(KYC_TIERS[2].dailyLimit.amount).toBeGreaterThan(KYC_TIERS[1].dailyLimit.amount);
    expect(KYC_TIERS[3].maxBalance).toBeNull();
  });
});
