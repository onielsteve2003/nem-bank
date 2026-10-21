import type { Schema } from '@nem/contracts';

import { ApiError } from '@/data';

import {
  counterpartOf,
  expiresIn,
  openCount,
  requestErrorMessage,
  requestSubtitle,
  sortRequests,
} from '../requests';

type MoneyRequest = Schema<'MoneyRequest'>;

const now = Date.parse('2026-10-21T10:00:00Z');
const amaka = { user_id: 'u1', name: 'Amaka Obi', nemtag: 'amaka_o' };
const tolu = { user_id: 'u0', name: 'Tolu Adebayo', nemtag: 'tolu_a' };

const request = (over: Partial<MoneyRequest>): MoneyRequest => ({
  id: 'r1',
  direction: 'incoming',
  requester: amaka,
  payer: tolu,
  amount: { amount_minor: '750000', currency: 'NGN' },
  note: 'Suya on Friday',
  status: 'pending',
  split_bill_id: null,
  transfer_id: null,
  created_at: '2026-10-20T10:00:00Z',
  expires_at: '2026-10-27T10:00:00Z',
  responded_at: null,
  ...over,
});

describe('money requests', () => {
  it('shows the other person on each side', () => {
    expect(counterpartOf(request({})).name).toBe('Amaka Obi');
    expect(
      counterpartOf(request({ direction: 'outgoing', requester: tolu, payer: amaka })).name,
    ).toBe('Amaka Obi');
  });

  it('counts down to expiry in days', () => {
    expect(expiresIn('2026-10-27T10:00:00Z', now)).toBe('in 6 days');
    expect(expiresIn('2026-10-22T09:00:00Z', now)).toBe('tomorrow');
    expect(expiresIn('2026-10-21T09:00:00Z', now)).toBe('today');
  });

  it('describes open and answered requests', () => {
    expect(requestSubtitle(request({}), now)).toBe('Suya on Friday · expires in 6 days');
    expect(requestSubtitle(request({ status: 'declined', note: '' }), now)).toBe(
      'No note · declined',
    );
  });

  it('puts open requests first, soonest to lapse on top', () => {
    const list = [
      request({ id: 'paid', status: 'paid', created_at: '2026-10-19T00:00:00Z' }),
      request({ id: 'late', expires_at: '2026-11-01T00:00:00Z' }),
      request({ id: 'newer-paid', status: 'paid', created_at: '2026-10-20T12:00:00Z' }),
      request({ id: 'soon', expires_at: '2026-10-22T00:00:00Z' }),
    ];
    expect(sortRequests(list).map((r) => r.id)).toEqual(['soon', 'late', 'newer-paid', 'paid']);
    expect(openCount(list)).toBe(2);
    expect(openCount(undefined)).toBe(0);
  });

  it('explains failures in plain words', () => {
    const closed = new ApiError({
      type: 'x',
      title: 'This request is no longer open',
      status: 409,
      code: 'invalid_state',
    });
    expect(requestErrorMessage(closed)).toBe('This request is no longer open.');
    expect(requestErrorMessage(new Error('boom'))).toMatch(/Try again/);
  });
});
