import type { Schema } from '@nem/contracts';

import {
  describeSchedule,
  lagosDayOf,
  scheduleBody,
  scheduleError,
  scheduleSubtitle,
  sortSchedules,
  startAtFor,
  startPresets,
} from '../schedule';

type ScheduledTransfer = Schema<'ScheduledTransfer'>;

const today = '2026-10-21';

const schedule = (over: Partial<ScheduledTransfer>): ScheduledTransfer => ({
  id: 's1',
  source_account_id: 'a1',
  recipient: {
    name: 'Amaka Obi',
    nemtag: 'amaka_o',
    bank_code: '999',
    bank_name: 'Nem Bank',
    account_number_masked: '******6789',
  },
  amount: { amount_minor: '500000', currency: 'NGN' },
  narration: 'Rent',
  frequency: 'weekly',
  status: 'active',
  next_run_at: '2026-10-22T08:00:00.000Z',
  ends_on: null,
  run_count: 0,
  last_run: null,
  created_at: '2026-10-21T10:00:00.000Z',
  ...over,
});

describe('schedule rules', () => {
  it('sends at 9 am Lagos time on the chosen day', () => {
    expect(startAtFor('2026-10-22')).toBe('2026-10-22T08:00:00.000Z');
    expect(lagosDayOf('2026-10-22T23:30:00.000Z')).toBe('2026-10-23');
  });

  it('offers tomorrow, a week out and the 1st of next month, never today', () => {
    expect(startPresets(today).map((p) => p.date)).toEqual([
      '2026-10-22',
      '2026-10-28',
      '2026-11-01',
    ]);
    expect(startPresets('2026-12-31').at(-1)!.date).toBe('2027-01-01');
  });

  it('refuses today, more than a year out and an end before the start', () => {
    const base = { frequency: 'weekly' as const, endsOn: null };
    expect(scheduleError({ ...base, startDate: today }, today)).toMatch(/tomorrow/);
    expect(scheduleError({ ...base, startDate: '2027-10-22' }, today)).toMatch(/year/);
    expect(
      scheduleError({ ...base, startDate: '2026-10-25', endsOn: '2026-10-24' }, today),
    ).toMatch(/last day/i);
    expect(scheduleError({ ...base, startDate: '2026-10-25', endsOn: '2026-10-25' }, today)).toBe(
      null,
    );
    // A one-off ignores an end day it cannot use.
    expect(
      scheduleError({ frequency: 'once', startDate: '2026-10-25', endsOn: '2026-10-01' }, today),
    ).toBe(null);
  });

  it('describes the schedule in words and builds the request', () => {
    expect(describeSchedule({ frequency: 'once', startDate: '2026-10-22', endsOn: null })).toMatch(
      /^Once on Thu.*22 Oct/,
    );
    const monthly = {
      frequency: 'monthly' as const,
      startDate: '2026-11-01',
      endsOn: '2026-12-31',
    };
    expect(describeSchedule(monthly)).toMatch(/^Every month from Sun.*1 Nov until 31 Dec 2026$/);
    expect(scheduleBody(monthly)).toEqual({
      frequency: 'monthly',
      start_at: '2026-11-01T08:00:00.000Z',
      ends_on: '2026-12-31',
    });
    expect(scheduleBody({ ...monthly, frequency: 'once' })).not.toHaveProperty('ends_on');
  });

  it('says what happens next, or how it ended', () => {
    expect(scheduleSubtitle(schedule({}))).toMatch(/^Every week · next Thu.*22 Oct/);
    expect(scheduleSubtitle(schedule({ status: 'paused' }))).toBe('Every week · paused');
    expect(
      scheduleSubtitle(schedule({ status: 'completed', next_run_at: null, run_count: 1 })),
    ).toBe('Every week · finished after 1 payment');
    expect(
      scheduleSubtitle(schedule({ status: 'cancelled', next_run_at: null, run_count: 3 })),
    ).toBe('Every week · cancelled after 3 payments');
  });

  it('lists live schedules soonest first, then ended ones newest first', () => {
    const list = [
      schedule({ id: 'old', status: 'cancelled', next_run_at: null, created_at: '2026-01-01' }),
      schedule({ id: 'late', next_run_at: '2026-11-01T08:00:00.000Z' }),
      schedule({ id: 'new', status: 'completed', next_run_at: null, created_at: '2026-09-01' }),
      schedule({ id: 'soon', status: 'paused', next_run_at: '2026-10-23T08:00:00.000Z' }),
    ];
    expect(sortSchedules(list).map((s) => s.id)).toEqual(['soon', 'late', 'new', 'old']);
  });
});
