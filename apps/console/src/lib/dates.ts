// Calendar dates as the contract sends them: YYYY-MM-DD in Africa/Lagos.

const DAY_MS = 86_400_000;

/** Today's calendar date in Africa/Lagos (the contract's Date zone). */
export function lagosDate(nowMs: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(nowMs);
}

export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Days from `from` to `to`, counting both ends. */
export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;

const dateTime = new Intl.DateTimeFormat('en-NG', {
  timeZone: 'Africa/Lagos',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** A contract timestamp as staff read it, in Lagos time: "3 Nov 2026, 10:14". */
export const formatDateTime = (iso: string): string => dateTime.format(Date.parse(iso));
