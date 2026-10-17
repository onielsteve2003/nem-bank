import { applySpread, convertAtRate, formatRate, parseRate } from './fx';
import { money } from './money';

describe('parseRate', () => {
  it('parses a decimal rate exactly', () => {
    expect(parseRate('1612.45')).toEqual({ numerator: 161245n, denominator: 100n });
    expect(parseRate('0.00062')).toEqual({ numerator: 62n, denominator: 100000n });
  });

  it.each(['', '1.', '01.5', '1.123456789', '-1', '1e3', '0'])('rejects "%s"', (rate) => {
    expect(() => parseRate(rate)).toThrow();
  });
});

describe('formatRate', () => {
  it('trims trailing zeros and rounds to 8 places', () => {
    expect(formatRate({ numerator: 3n, denominator: 2n }, 'floor')).toBe('1.5');
    expect(formatRate({ numerator: 1n, denominator: 3n }, 'floor')).toBe('0.33333333');
    expect(formatRate({ numerator: 2n, denominator: 3n }, 'half-up')).toBe('0.66666667');
    expect(formatRate({ numerator: 1600n, denominator: 1n }, 'floor')).toBe('1600');
  });
});

describe('applySpread', () => {
  it('takes the spread off the mid rate and rounds down', () => {
    expect(applySpread('1600', 150)).toBe('1576');
    expect(applySpread('0.000625', 150)).toBe('0.00061562');
    expect(applySpread('1600', 0)).toBe('1600');
  });

  it('rejects fractional or out-of-range spreads', () => {
    expect(() => applySpread('1600', 1.5)).toThrow(RangeError);
    expect(() => applySpread('1600', 10_000)).toThrow(RangeError);
  });
});

describe('convertAtRate', () => {
  it('converts minor units through an exact rate', () => {
    // $100.00 at ₦1,576 per dollar is ₦157,600.00.
    expect(convertAtRate(money(10_000n, 'USD'), '1576', 'NGN', 'floor')).toEqual(
      money(15_760_000n, 'NGN'),
    );
  });

  it('applies the named rounding to fractional minor units', () => {
    // ₦1,000.00 at 0.00061562 USD per naira is $0.61562.
    const naira = money(100_000n, 'NGN');
    expect(convertAtRate(naira, '0.00061562', 'USD', 'floor')).toEqual(money(61n, 'USD'));
    expect(convertAtRate(naira, '0.00061562', 'USD', 'half-up')).toEqual(money(62n, 'USD'));
  });
});
