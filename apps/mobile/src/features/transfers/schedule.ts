import type { Schema } from '@nem/contracts';
import { addDaysIso, addMonthsIso } from '@nem/shared';

import type { Tone } from '@/components';
import i18n, { localized, withLabel } from '@/lib/i18n';

type Frequency = Schema<'ScheduleFrequency'>;
type ScheduledTransfer = Schema<'ScheduledTransfer'>;

export const FREQUENCIES = localized<Frequency>({
  once: 'transfers.schedule.frequencies.once',
  daily: 'transfers.schedule.frequencies.daily',
  weekly: 'transfers.schedule.frequencies.weekly',
  monthly: 'transfers.schedule.frequencies.monthly',
});

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
    {
      key: 'tomorrow',
      label: i18n.t('transfers.schedule.presets.tomorrow'),
      date: addDaysIso(today, 1),
    },
    { key: 'week', label: i18n.t('transfers.schedule.presets.week'), date: addDaysIso(today, 7) },
    {
      key: 'month',
      label: i18n.t('transfers.schedule.presets.month'),
      date: addMonthsIso(`${today.slice(0, 8)}01`, 1),
    },
  ] as const;
}

/** Why the schedule cannot be saved, or null when it can. */
export function scheduleError(choice: ScheduleChoice, today: string): string | null {
  if (choice.startDate <= today) return i18n.t('transfers.schedule.fromTomorrow');
  if (choice.startDate > addDaysIso(today, MAX_START_DAYS)) {
    return i18n.t('transfers.schedule.withinYear');
  }
  if (choice.frequency !== 'once' && choice.endsOn && choice.endsOn < choice.startDate) {
    return i18n.t('transfers.schedule.endAfterStart');
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
  if (choice.frequency === 'once') return i18n.t('transfers.schedule.onceOn', { day: start });
  const every = FREQUENCIES[choice.frequency];
  return choice.endsOn
    ? i18n.t('transfers.schedule.repeatUntil', {
        every,
        day: start,
        end: formatEndDay(choice.endsOn),
      })
    : i18n.t('transfers.schedule.repeat', { every, day: start });
}

export const STATUS_LABELS: Record<
  ScheduledTransfer['status'],
  { readonly label: string; tone: Tone }
> = {
  active: withLabel('transfers.schedule.status.active', { tone: 'success' }),
  paused: withLabel('transfers.schedule.status.paused', { tone: 'warning' }),
  cancelled: withLabel('transfers.schedule.status.cancelled', { tone: 'neutral' }),
  completed: withLabel('transfers.schedule.status.completed', { tone: 'neutral' }),
};

export const isLive = (s: ScheduledTransfer) => s.status === 'active' || s.status === 'paused';

/** One line under the recipient: what happens next, or how it ended. */
export function scheduleSubtitle(s: ScheduledTransfer): string {
  const every = FREQUENCIES[s.frequency];
  if (s.status === 'paused') return i18n.t('transfers.schedule.subtitlePaused', { every });
  if (s.status === 'active' && s.next_run_at) {
    return i18n.t('transfers.schedule.subtitleNext', {
      every,
      day: formatScheduleDay(lagosDayOf(s.next_run_at)),
    });
  }
  return i18n.t(
    s.status === 'cancelled'
      ? 'transfers.schedule.subtitleCancelled'
      : 'transfers.schedule.subtitleFinished',
    { every, count: s.run_count },
  );
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
