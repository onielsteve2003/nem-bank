import type { Schema } from '@nem/contracts';

import {
  canRemind,
  isSettled,
  paidCount,
  paidFraction,
  parseNairaText,
  remindable,
  remindedAgo,
} from '../splits';

type SplitShare = Schema<'SplitShare'>;

const now = Date.parse('2026-10-21T12:00:00Z');
const ngn = (minor: number) => ({ amount_minor: String(minor), currency: 'NGN' as const });
const share = (over: Partial<SplitShare>): SplitShare => ({
  participant: { user_id: 'u1', name: 'Amaka Obi', nemtag: 'amaka_o' },
  amount: ngn(300_000),
  status: 'pending',
  money_request_id: 'r1',
  last_reminded_at: null,
  ...over,
});
const split = (shares: SplitShare[], paid: number): Schema<'SplitBill'> => ({
  id: 's1',
  title: 'Dinner',
  total: ngn(900_000),
  split: 'equal',
  shares,
  paid_total: ngn(paid),
  created_at: '2026-10-21T10:00:00Z',
});

describe('split bills', () => {
  it('reads typed naira amounts as kobo', () => {
    expect(parseNairaText('12,500')).toBe(1_250_000n);
    expect(parseNairaText('₦ 3000.5')).toBe(300_050n);
    expect(parseNairaText('0.07')).toBe(7n);
    expect(parseNairaText('0')).toBeNull();
    expect(parseNairaText('1.234')).toBeNull();
    expect(parseNairaText('abc')).toBeNull();
  });

  it('tracks how much is paid and by how many friends', () => {
    const me = share({
      participant: { user_id: 'u0', name: 'Tolu Adebayo', nemtag: 'tolu_a' },
      status: 'paid',
      money_request_id: null,
    });
    const s = split([me, share({ status: 'paid' }), share({ money_request_id: 'r2' })], 600_000);
    expect(paidFraction(s)).toBeCloseTo(2 / 3, 3);
    expect(paidCount(s)).toEqual({ paid: 1, of: 2 });
    expect(isSettled(s)).toBe(false);
    expect(isSettled(split([me, share({ status: 'paid' })], 900_000))).toBe(true);
  });

  it('reminds each person at most once a day, and never the creator', () => {
    expect(canRemind(share({}), now)).toBe(true);
    expect(canRemind(share({ last_reminded_at: '2026-10-21T01:00:00Z' }), now)).toBe(false);
    expect(canRemind(share({ last_reminded_at: '2026-10-20T11:59:00Z' }), now)).toBe(true);
    expect(canRemind(share({ status: 'paid' }), now)).toBe(false);
    expect(canRemind(share({ money_request_id: null }), now)).toBe(false);
    const s = split(
      [share({}), share({ money_request_id: 'r2', last_reminded_at: '2026-10-21T11:00:00Z' })],
      0,
    );
    expect(remindable(s, now)).toBe(1);
  });

  it('says how long ago someone was reminded', () => {
    expect(remindedAgo('2026-10-21T11:59:45Z', now)).toBe('Reminded just now');
    expect(remindedAgo('2026-10-21T11:55:00Z', now)).toBe('Reminded 5 min ago');
    expect(remindedAgo('2026-10-21T09:00:00Z', now)).toBe('Reminded 3 h ago');
  });
});
