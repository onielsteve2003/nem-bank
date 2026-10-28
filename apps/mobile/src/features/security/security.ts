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
    case 'single_device':
      return { kind: 'route', href: '/security/devices' };
    default:
      // Limits (T14.3), duress PIN (T14.5), alerts (T14.7) and biometrics
      // (settings, T19) get their screens in later tasks.
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

/** A device's trust in words: a new device has lower limits until its cool-off ends (AUTH-8). */
export function deviceStatus(d: Schema<'Device'>, now: Date = new Date()): { label: string } {
  if (d.cool_off_until && new Date(d.cool_off_until) > now)
    return { label: 'New device, lower limits for now' };
  if (!d.trusted) return { label: 'Not trusted yet' };
  return { label: d.hardware_backed ? 'Trusted, key in secure hardware' : 'Trusted' };
}

/** Sign-ins that can be ended from here: everything except this one. */
export const otherSessions = (sessions: readonly Schema<'Session'>[]) =>
  sessions.filter((s) => !s.current);
