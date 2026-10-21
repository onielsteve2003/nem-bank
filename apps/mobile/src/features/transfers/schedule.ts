import type { Schema } from '@nem/contracts';
import { addDaysIso, addMonthsIso } from '@nem/shared';

import type { Tone } from '@/components';

type Frequency = Schema<'ScheduleFrequency'>;
type ScheduledTransfer = Schema<'ScheduledTransfer'>;

export const FREQUENCIES: Record<Frequency, string> = {
  once: 'Once',
  daily: 'Every day',
  weekly: 'Every week',
  monthly: 'Every month',
};

/** Scheduled payments go out at 9 am Lagos time (UTC+1, no daylight saving). */
const SEND_HOUR_UTC = 8;
/** How far ahead a first payment can be set. */
export const MAX_START_DAYS = 365;

/** A payment that waits, and maybe repeats (TRF-9). Dates are Lagos calendar days. */
export interface ScheduleChoice {
  frequency: Frequency;
  startDate: string;
  /** Last day a repeat may run on; null runs until cancelled. Ignored for `once`. */
  endsOn: string | null;
}

/** The instant the first payment goes: 9 am in Lagos on the start day. */
export const startAtFor = (date: string) =>
  `${date}T${String(SEND_HOUR_UTC).padStart(2, '0')}:00:00.000Z`;

/** Quick picks for the first payment day. Today is never one: 9 am may have passed. */
export function startPresets(today: string) {
  return [
    { key: 'tomorrow', label: 'Tomorrow', date: addDaysIso(today, 1) },
    { key: 'week', label: 'In a week', date: addDaysIso(today, 7) },
    { key: 'month', label: '1st of next month', date: addMonthsIso(`${today.slice(0, 8)}01`, 1) },
  ] as const;
}

/** Why the schedule cannot be saved, or null when it can. */
export function scheduleError(choice: ScheduleChoice, today: string): string | null {
  if (choice.startDate <= today) return 'Pick a day from tomorrow on';
  if (choice.startDate > addDaysIso(today, MAX_START_DAYS)) return 'Pick a day within a year';
  if (choice.frequency !== 'once' && choice.endsOn && choice.endsOn < choice.startDate) {
    return 'The last day must be on or after the first payment';
  }
  return null;
}

const shortDay = new Intl.DateTimeFormat('en-NG', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const longDay = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "2026-10-22" → "Thu, 22 Oct" (a calendar date, so no zone shift). */
export const formatScheduleDay = (iso: string) => shortDay.format(new Date(`${iso}T00:00:00Z`));
const formatEndDay = (iso: string) => longDay.format(new Date(`${iso}T00:00:00Z`));

/** The Lagos calendar day an instant falls on. */
export const lagosDayOf = (at: string) =>
  new Date(Date.parse(at) + 60 * 60_000).toISOString().slice(0, 10);

/** "Every week from Thu, 22 Oct until 31 Dec 2026", or "Once on Thu, 22 Oct". */
export function describeSchedule(choice: ScheduleChoice): string {
  const start = formatScheduleDay(choice.startDate);
  if (choice.frequency === 'once') return `Once on ${start}`;
  const until = choice.endsOn ? ` until ${formatEndDay(choice.endsOn)}` : '';
  return `${FREQUENCIES[choice.frequency]} from ${start}${until}`;
}

export const STATUS_LABELS: Record<ScheduledTransfer['status'], { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'success' },
  paused: { label: 'Paused', tone: 'warning' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  completed: { label: 'Finished', tone: 'neutral' },
};

export const isLive = (s: ScheduledTransfer) => s.status === 'active' || s.status === 'paused';

/** One line under the recipient: what happens next, or how it ended. */
export function scheduleSubtitle(s: ScheduledTransfer): string {
  const every = FREQUENCIES[s.frequency];
  if (s.status === 'paused') return `${every} · paused`;
  if (s.status === 'active' && s.next_run_at) {
    return `${every} · next ${formatScheduleDay(lagosDayOf(s.next_run_at))}`;
  }
  const runs = s.run_count === 1 ? '1 payment' : `${s.run_count} payments`;
  return `${every} · ${s.status === 'cancelled' ? 'cancelled' : 'finished'} after ${runs}`;
}

/** Live schedules first (soonest next), then ended ones newest first. */
export function sortSchedules(list: ScheduledTransfer[]): ScheduledTransfer[] {
  const rank = (s: ScheduledTransfer) => (isLive(s) ? 0 : 1);
  return [...list].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (isLive(a)
        ? (a.next_run_at ?? '9').localeCompare(b.next_run_at ?? '9')
        : b.created_at.localeCompare(a.created_at)),
  );
}

/** The schedule as the create call wants it. */
export function scheduleBody(choice: ScheduleChoice) {
  return {
    frequency: choice.frequency,
    start_at: startAtFor(choice.startDate),
    ...(choice.frequency !== 'once' && choice.endsOn ? { ends_on: choice.endsOn } : {}),
  };
}
