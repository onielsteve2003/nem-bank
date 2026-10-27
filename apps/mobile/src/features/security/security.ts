import type { Schema } from '@nem/contracts';
import type { Href } from 'expo-router';
import { ShieldAlert, ShieldCheck, ShieldHalf, type LucideIcon } from 'lucide-react-native';

type Item = Schema<'CheckupItem'>;

export type Band = {
  label: string;
  icon: LucideIcon;
  color: 'success' | 'warning' | 'danger';
};

/** The score in words, so it never relies on the ring's colour alone. */
export function scoreBand(score: number): Band {
  if (score >= 80) return { label: 'Strong', icon: ShieldCheck, color: 'success' };
  if (score >= 50) return { label: 'Good, could be better', icon: ShieldHalf, color: 'warning' };
  return { label: 'Needs attention', icon: ShieldAlert, color: 'danger' };
}

/** What still needs doing, biggest gain first, then what is already done. */
export function splitCheckup(items: readonly Item[]) {
  const todo = items.filter((i) => !i.done).sort((a, b) => b.points - a.points);
  const done = items.filter((i) => i.done);
  return { todo, done };
}

/**
 * Where each to-do is fixed. `question` opens a sheet on this screen; `null`
 * means the screen that fixes it is not built yet.
 */
export type CheckupAction = { kind: 'route'; href: Href } | { kind: 'question' } | null;

export function checkupAction(id: Item['id']): CheckupAction {
  switch (id) {
    case 'kyc_tier_2':
      return { kind: 'route', href: '/kyc' };
    case 'security_question_set':
      return { kind: 'question' };
    default:
      // Devices (T14.2), limits (T14.3), duress PIN (T14.5), alerts (T14.7) and
      // biometrics (settings, T19) get their screens in later tasks.
      return null;
  }
}

/** Questions people can answer the same way for years, and a stranger can't look up. */
export const SECURITY_QUESTIONS = [
  'What was the name of your first primary school?',
  'What was the name of your childhood best friend?',
  'In which town did your parents meet?',
  'What was the first thing you ever bought with your own money?',
] as const;
