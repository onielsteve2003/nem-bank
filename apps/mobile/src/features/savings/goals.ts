import type { Schema } from '@nem/contracts';

type Goal = Schema<'SavingsGoal'>;

const day = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "2027-01-31" → "31 Jan 2027" (a calendar date, so no zone shift). */
export const formatGoalDate = (iso: string) => day.format(new Date(`${iso}T00:00:00Z`));

/** "40% · by 31 Jan 2027", or "Target reached". */
export function goalSubtitle(goal: Goal): string {
  if (goal.status === 'completed') return 'Target reached';
  if (goal.status === 'closed') return 'Closed';
  const by = goal.target_date ? ` · by ${formatGoalDate(goal.target_date)}` : '';
  return `${goal.progress_pct}% saved${by}`;
}

/** Open goals first (closest to done first), then closed ones. */
export function sortGoals(goals: Goal[]): Goal[] {
  const rank = (g: Goal) => (g.status === 'closed' ? 1 : 0);
  return [...goals].sort((a, b) => rank(a) - rank(b) || b.progress_pct - a.progress_pct);
}
