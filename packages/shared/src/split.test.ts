import { customSharesError, equalShares } from './split';

describe('equalShares', () => {
  it('gives the leftover kobo to the creator so shares add up', () => {
    // ₦100.00 between 3 people: 33.34 for the creator, 33.33 each for two friends.
    expect(equalShares(10_000n, 2, true)).toEqual({ self: 3_334n, friends: [3_333n, 3_333n] });
  });

  it('gives the leftover to the first friend when the creator is not in it', () => {
    expect(equalShares(10_000n, 3, false)).toEqual({
      self: 0n,
      friends: [3_334n, 3_333n, 3_333n],
    });
  });

  it('always adds up to the total', () => {
    for (const [total, friends, self] of [
      [1n, 4, true],
      [99_999n, 7, false],
      [5_000_000n, 20, true],
    ] as const) {
      const s = equalShares(total, friends, self);
      expect(s.friends.reduce((a, b) => a + b, s.self)).toBe(total);
    }
  });

  it('has no friend shares without friends', () => {
    expect(equalShares(10_000n, 0, true)).toEqual({ self: 10_000n, friends: [] });
  });
});

describe('customSharesError', () => {
  it('needs a positive amount for everyone', () => {
    expect(customSharesError(10_000n, [5_000n, 0n], true)).toMatch(/everyone/);
  });

  it('lets the creator keep the rest, but never asks for more than the total', () => {
    expect(customSharesError(10_000n, [3_000n, 2_000n], true)).toBeNull();
    expect(customSharesError(10_000n, [6_000n, 5_000n], true)).toMatch(/more than/);
  });

  it('needs an exact total when the creator is not in it', () => {
    expect(customSharesError(10_000n, [3_000n, 2_000n], false)).toMatch(/add up/);
    expect(customSharesError(10_000n, [6_000n, 4_000n], false)).toBeNull();
  });
});
