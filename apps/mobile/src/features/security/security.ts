import type { Schema } from '@nem/contracts';
import { compare, formatMoney, type Money } from '@nem/shared';
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
    case 'self_limit_set':
      return { kind: 'route', href: '/security/limits' };
    case 'duress_pin_set':
      return { kind: 'route', href: '/security/duress' };
    default:
      // Alerts (T14.7) and biometrics
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

/** What panic mode did, in words. */
export function panicSummary(p: Schema<'PanicState'>): string {
  if (!p.active) return 'Panic mode is off.';
  const cards =
    p.cards_frozen === 0
      ? 'No cards needed freezing'
      : `${p.cards_frozen} ${p.cards_frozen === 1 ? 'card' : 'cards'} frozen`;
  return `${cards}${p.outgoing_blocked ? ' and no money can leave your account' : ''}.`;
}

/** A self-set limit; `null` means none, so only the KYC cap applies. */
export type Limit = Money | null;

/**
 * Whether a new limit tightens or loosens protection. Removing a limit counts
 * as raising it. Loosening needs a PIN and waits 24 hours (SEC-3).
 */
export function limitChange(current: Limit, next: Limit): 'lower' | 'raise' | 'same' {
  if (current === null) return next === null ? 'same' : 'lower';
  if (next === null) return 'raise';
  const c = compare(next, current);
  return c === 0 ? 'same' : c < 0 ? 'lower' : 'raise';
}

/** Why a pair of limits can't be saved, or undefined. The bank checks the same rules. */
export function limitsProblem(daily: Limit, single: Limit, cap: Money): string | undefined {
  if (daily && compare(daily, cap) > 0)
    return `Your daily limit can't be above your KYC cap of ${formatMoney(cap, { trimZeroMinor: true })}`;
  if (single && compare(single, cap) > 0)
    return `A single transfer can't be above your KYC cap of ${formatMoney(cap, { trimZeroMinor: true })}`;
  if (daily && single && compare(single, daily) > 0)
    return "A single transfer can't be above your daily limit";
  return undefined;
}
