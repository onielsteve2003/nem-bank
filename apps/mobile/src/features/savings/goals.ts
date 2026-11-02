import type { Schema } from '@nem/contracts';

import i18n, { localized } from '@/lib/i18n';

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
  if (goal.status === 'completed') return i18n.t('savings.subtitle.completed');
  if (goal.status === 'closed') return i18n.t('savings.subtitle.closed');
  const pct = goal.progress_pct;
  return goal.target_date
    ? i18n.t('savings.subtitle.savedBy', { pct, date: formatGoalDate(goal.target_date) })
    : i18n.t('savings.subtitle.saved', { pct });
}

/** Open goals first (closest to done first), then closed ones. */
export function sortGoals(goals: Goal[]): Goal[] {
  const rank = (g: Goal) => (g.status === 'closed' ? 1 : 0);
  return [...goals].sort((a, b) => rank(a) - rank(b) || b.progress_pct - a.progress_pct);
}

export const GOAL_EMOJIS = ['🎯', '🏠', '🚗', '✈️', '🎓', '💍', '🎉', '📱', '👶', '🏥', '💼', '🎁'];

export type AutoSaveFrequency = Schema<'AutoSaveRule'>['frequency'];

export const AUTO_SAVE_FREQUENCIES = localized<AutoSaveFrequency>({
  daily: 'savings.autoSave.frequencies.daily',
  weekly: 'savings.autoSave.frequencies.weekly',
  monthly: 'savings.autoSave.frequencies.monthly',
});

/** Quick auto-save amounts, in naira. */
export const AUTO_SAVE_PRESETS = [1_000, 5_000, 10_000, 20_000, 50_000] as const;

/** "₦20,000 every week", the rule in words. */
export const describeAutoSave = (amountText: string, frequency: AutoSaveFrequency) =>
  i18n.t(`savings.autoSave.describe.${frequency}`, { amount: amountText });

/** Goal names: 1 to 40 characters once trimmed. */
export const MAX_GOAL_NAME = 40;
