// Statement periods (ACC-8). Dates are ISO calendar days in Lagos, inclusive at
// both ends. The form and the mock bank apply the same rules.

export const MAX_STATEMENT_MONTHS = 12;

const DAY_MS = 86_400_000;
const parts = (iso: string) => iso.split('-').map(Number) as [number, number, number];
const iso = (y: number, m: number, d: number) =>
  new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);

/** The same day N months away; the 31st clamps to the month's last day. */
export function addMonthsIso(date: string, months: number): string {
  const [y, m, d] = parts(date);
  const lastDay = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return iso(y, m + months, Math.min(d, lastDay));
}

export const addDaysIso = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Why a period cannot have a statement, or null when it can. */
export function statementRangeError(from: string, to: string, today: string): string | null {
  if (from > to) return 'The start date is after the end date';
  if (to > today) return 'Statements cannot cover future dates';
  if (from <= addMonthsIso(to, -MAX_STATEMENT_MONTHS)) {
    return `A statement covers up to ${MAX_STATEMENT_MONTHS} months`;
  }
  return null;
}
