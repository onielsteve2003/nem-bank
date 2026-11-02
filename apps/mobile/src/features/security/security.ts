import type { Schema } from '@nem/contracts';
import { compare, formatMoney, type Money } from '@nem/shared';
import type { Href } from 'expo-router';
import {
  ShieldAlert,
  ShieldCheck,
  ShieldHalf,
  ShieldX,
  type LucideIcon,
} from 'lucide-react-native';

import i18n from '@/lib/i18n';

type Item = Schema<'CheckupItem'>;

export type Band = {
  label: string;
  icon: LucideIcon;
  color: 'success' | 'warning' | 'danger';
};

/** The score in words, so it never relies on the ring's colour alone. */
export function scoreBand(score: number): Band {
  if (score >= 80)
    return { label: i18n.t('security.score.strong'), icon: ShieldCheck, color: 'success' };
  if (score >= 50)
    return { label: i18n.t('security.score.good'), icon: ShieldHalf, color: 'warning' };
  return { label: i18n.t('security.score.weak'), icon: ShieldAlert, color: 'danger' };
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
    case 'alerts_on':
      return { kind: 'route', href: '/security/alerts' };
    default:
      // Biometrics
      // (settings, T19) get their screens in later tasks.
      return null;
  }
}

/** Questions people can answer the same way for years, and a stranger can't look up. */
export const securityQuestions = (): readonly string[] =>
  i18n.t('security.question.list', { returnObjects: true });

/** A device's trust in words: a new device has lower limits until its cool-off ends (AUTH-8). */
export function deviceStatus(d: Schema<'Device'>, now: Date = new Date()): { label: string } {
  if (d.cool_off_until && new Date(d.cool_off_until) > now)
    return { label: i18n.t('security.devices.status.new') };
  if (!d.trusted) return { label: i18n.t('security.devices.status.untrusted') };
  return {
    label: i18n.t(
      d.hardware_backed ? 'security.devices.status.hardware' : 'security.devices.status.trusted',
    ),
  };
}

/** Sign-ins that can be ended from here: everything except this one. */
export const otherSessions = (sessions: readonly Schema<'Session'>[]) =>
  sessions.filter((s) => !s.current);

/** What panic mode did, in words. */
export function panicSummary(p: Schema<'PanicState'>): string {
  if (!p.active) return i18n.t('security.panic.summaryOff');
  const cards =
    p.cards_frozen === 0
      ? i18n.t('security.panic.noCards')
      : i18n.t('security.panic.cardsFrozen', { count: p.cards_frozen });
  return i18n.t(p.outgoing_blocked ? 'security.panic.summaryBlocked' : 'security.panic.summary', {
    cards,
  });
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
    return i18n.t('security.limits.aboveCapDaily', {
      cap: formatMoney(cap, { trimZeroMinor: true }),
    });
  if (single && compare(single, cap) > 0)
    return i18n.t('security.limits.aboveCapSingle', {
      cap: formatMoney(cap, { trimZeroMinor: true }),
    });
  if (daily && single && compare(single, daily) > 0)
    return i18n.t('security.limits.singleAboveDaily');
  return undefined;
}

export type ScamKind = Schema<'ScamCheckRequest'>['kind'];

/**
 * What was pasted, so the right check runs without asking: ten digits is an
 * account number, a single web address is a link, anything else a message.
 */
export function guessScamKind(text: string): ScamKind {
  const t = text.trim();
  if (/^[\d\s-]+$/.test(t) && t.replace(/\D/g, '').length === 10) return 'account_number';
  if (/^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(t)) return 'link';
  return 'message';
}

/** The scam checker's verdict in words and icon, never colour alone (SEC-6). */
export function scamVerdict(v: Schema<'ScamCheckResult'>['verdict']): Band {
  switch (v) {
    case 'likely_scam':
      return {
        label: i18n.t('security.scam.verdicts.likely_scam'),
        icon: ShieldX,
        color: 'danger',
      };
    case 'suspicious':
      return {
        label: i18n.t('security.scam.verdicts.suspicious'),
        icon: ShieldAlert,
        color: 'warning',
      };
    default:
      return { label: i18n.t('security.scam.verdicts.safe'), icon: ShieldCheck, color: 'success' };
  }
}

/** Payment alert thresholds offered as presets, in naira. Zero means every payment. */
export const ALERT_THRESHOLDS = [0, 1_000, 5_000, 20_000, 100_000] as const;

/** A payment alert threshold in words. */
export function alertThresholdLabel(threshold: Money): string {
  if (threshold.amount === 0n) return i18n.t('security.alerts.everyPayment');
  return i18n.t('security.alerts.orMore', {
    amount: formatMoney(threshold, { trimZeroMinor: true }),
  });
}

/** The device whose cool-off keeps new-device alerts on, if any (AUTH-8). */
export function coolingOffDevice(
  devices: readonly Schema<'Device'>[],
  now: Date = new Date(),
): Schema<'Device'> | undefined {
  return devices.find((d) => d.cool_off_until && new Date(d.cool_off_until) > now);
}
