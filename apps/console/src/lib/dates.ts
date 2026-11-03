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
