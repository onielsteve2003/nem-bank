import {
  add,
  compare,
  CurrencyMismatchError,
  divideRounded,
  fromDto,
  money,
  parseMajor,
  percentOf,
  subtract,
  sum,
  toDto,
} from './money';

describe('money arithmetic', () => {
  it('adds and subtracts in minor units without float drift', () => {
    // 0.1 + 0.2 in naira
    expect(add(money(10, 'NGN'), money(20, 'NGN'))).toEqual(money(30n, 'NGN'));
    expect(subtract(money(10, 'NGN'), money(25, 'NGN')).amount).toBe(-15n);
  });

  it('is exact beyond Number.MAX_SAFE_INTEGER', () => {
    const big = money('9007199254740993', 'NGN');
    expect(add(big, money(1n, 'NGN')).amount).toBe(9007199254740994n);
  });

  it('refuses to mix currencies', () => {
    expect(() => add(money(1, 'NGN'), money(1, 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => compare(money(1, 'GBP'), money(1, 'EUR'))).toThrow(CurrencyMismatchError);
  });

  it('rejects fractional minor units', () => {
    expect(() => money(1.5, 'NGN')).toThrow(RangeError);
  });

  it('sums a list, starting from zero', () => {
    expect(sum([], 'USD')).toEqual(money(0n, 'USD'));
    expect(sum([money(1, 'USD'), money(2, 'USD')], 'USD').amount).toBe(3n);
  });
});

describe('rounding', () => {
  it.each([
    [5n, 2n, 'half-up', 3n],
    [-5n, 2n, 'half-up', -3n],
    [4n, 3n, 'half-up', 1n],
    [5n, 2n, 'floor', 2n],
    [-5n, 2n, 'floor', -3n],
    [5n, 2n, 'ceil', 3n],
    [-5n, 2n, 'ceil', -2n],
    [6n, 2n, 'ceil', 3n],
  ] as const)('%p / %p rounded %s is %p', (n, d, rounding, expected) => {
    expect(divideRounded(n, d, rounding)).toBe(expected);
  });

  it('takes basis-point percentages with explicit rounding', () => {
    // 1.5% of ₦333.33 = 499.995 kobo
    expect(percentOf(money(33_333, 'NGN'), 150n, 'half-up').amount).toBe(500n);
    expect(percentOf(money(33_333, 'NGN'), 150n, 'floor').amount).toBe(499n);
  });
});

describe('parseMajor', () => {
  it.each([
    ['1,500.5', 150_050n],
    ['₦20000', 2_000_000n],
    ['.5', 50n],
    ['7.', 700n],
    ['-12.34', -1_234n],
  ])('parses %p', (input, minor) => {
    expect(parseMajor(input, 'NGN').amount).toBe(minor);
  });

  it('rejects garbage and excess precision', () => {
    expect(() => parseMajor('', 'NGN')).toThrow(SyntaxError);
    expect(() => parseMajor('12a', 'NGN')).toThrow(SyntaxError);
    expect(() => parseMajor('1.005', 'USD')).toThrow(RangeError);
  });
});

describe('DTO round trip', () => {
  it('serialises the amount as a string', () => {
    const m = money(150_000, 'NGN');
    expect(toDto(m)).toEqual({ amount: '150000', currency: 'NGN' });
    expect(fromDto(toDto(m))).toEqual(m);
  });

  it('rejects float amounts and unknown currencies', () => {
    expect(() => fromDto({ amount: '1.5', currency: 'NGN' })).toThrow();
    expect(() => fromDto({ amount: '1', currency: 'JPY' })).toThrow();
  });
});
