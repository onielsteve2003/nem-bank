import { money } from '@nem/shared';

import { describeTravel } from '@/features/demo/timeTravel';

import { projectInterest } from '../projection';

describe('interest projections', () => {
  it('projects simple interest, rounded down to the kobo', () => {
    // ₦100,000 at 10% for a year is ₦10,000; for 30 days, ₦821.91 and a fraction.
    expect(projectInterest(money(10_000_000n, 'NGN'), 1_000, 365)).toEqual(
      money(1_000_000n, 'NGN'),
    );
    expect(projectInterest(money(10_000_000n, 'NGN'), 1_000, 30)).toEqual(money(82_191n, 'NGN'));
    expect(projectInterest(money(0n, 'NGN'), 1_000, 30).amount).toBe(0n);
  });

  it('says what a jump in time did to savings and ajo', () => {
    const before = { interest: 1_000n, matured: 0, turns: 1 };
    expect(describeTravel(before, { interest: 83_191n, matured: 1, turns: 2 })).toBe(
      '₦821.91 interest earned · 1 lock matured · 1 ajo payout made',
    );
    expect(describeTravel(before, before)).toBe('No savings or ajo activity was due.');
  });
});
