import type { Schema } from '@nem/contracts';
import { KYC_TIERS } from '@nem/shared';

import { problem } from '../../errors';
import type { SecurityRepo } from '../../repositories';
import { addMinutes, api, fromApi, positive } from '../convert';
import { externalAccountName } from '../directory';
import type { MockBank } from '../runtime';
import { assertStrongPin } from './auth';

const LIMIT_INCREASE_DELAY_HOURS = 24;

const CHECKUP: {
  id: Schema<'CheckupItem'>['id'];
  title: string;
  description: string;
  points: number;
}[] = [
  {
    id: 'pin_set',
    title: 'Set a transaction PIN',
    description: 'Every payment needs it.',
    points: 20,
  },
  {
    id: 'kyc_tier_2',
    title: 'Verify your BVN or NIN',
    description: 'Protects your account and raises your limits.',
    points: 20,
  },
  {
    id: 'biometrics_on',
    title: 'Turn on Face ID',
    description: 'Faster and safer than typing your PIN.',
    points: 10,
  },
  {
    id: 'security_question_set',
    title: 'Add a security question',
    description: 'A backup way to prove it is you.',
    points: 10,
  },
  {
    id: 'duress_pin_set',
    title: 'Set a duress PIN',
    description: 'If someone forces you to open the app, this PIN shows a decoy.',
    points: 10,
  },
  {
    id: 'self_limit_set',
    title: 'Set your own daily limit',
    description: 'Caps the damage if someone gets in.',
    points: 10,
  },
  {
    id: 'single_device',
    title: 'Review your devices',
    description: 'Remove devices you no longer use.',
    points: 10,
  },
  {
    id: 'alerts_on',
    title: 'Turn on login alerts',
    description: 'Know straight away if someone signs in.',
    points: 10,
  },
];

// Scam checker rules (SEC-6). Phrases seen in Nigerian bank-impersonation and
// "you have won" scams, plus link and account signals.
const SCAM_PHRASES: {
  pattern: RegExp;
  code: string;
  severity: 'medium' | 'high';
  message: string;
}[] = [
  {
    pattern: /\b(otp|one[- ]time (pass)?code|pin|cvv)\b/i,
    code: 'asks_for_secret',
    severity: 'high',
    message: 'It asks for a PIN, OTP or card code. No bank ever asks for these.',
  },
  {
    pattern: /\bbvn\b.*\b(update|link|verify|block)/i,
    code: 'bvn_update',
    severity: 'high',
    message: '"Update your BVN" messages are a common scam.',
  },
  {
    pattern: /\b(blocked|suspended|restricted|deactivated)\b/i,
    code: 'threat',
    severity: 'medium',
    message: 'It threatens to block your account to rush you.',
  },
  {
    pattern: /\b(urgent|immediately|within 24 ?hours|right now)\b/i,
    code: 'urgency',
    severity: 'medium',
    message: 'It pushes you to act fast.',
  },
  {
    pattern: /\b(won|winner|prize|promo|giveaway|lottery)\b/i,
    code: 'prize',
    severity: 'medium',
    message: 'Prizes you did not enter for are a classic scam.',
  },
  {
    pattern: /\b(send|pay|transfer).{0,30}\b(first|fee|charge|to claim|to receive)\b/i,
    code: 'advance_fee',
    severity: 'high',
    message: 'It asks you to pay first to receive money.',
  },
  {
    pattern: /\b(investment|double your money|guaranteed returns?|forex|crypto)\b/i,
    code: 'investment',
    severity: 'medium',
    message: 'Guaranteed or doubled returns are a red flag.',
  },
];
const SHORTENERS = /\b(bit\.ly|tinyurl\.com|t\.co|cutt\.ly|is\.gd|rb\.gy)\b/i;
const OUR_DOMAINS = /(^|\.)nem-bank-fodx\.vercel\.app$/i;

function checkScam(body: Schema<'ScamCheckRequest'>): Omit<Schema<'ScamCheckResult'>, 'ai'> {
  const reasons: Schema<'RiskReason'>[] = [];
  let reported: boolean | null = null;
  const text = body.content.trim();
  if (body.kind === 'account_number') {
    const digits = text.replace(/\D/g, '');
    if (digits.length !== 10)
      throw problem(422, 'validation_failed', 'Enter a 10-digit account number');
    // Demo reports: numbers ending 4444 or 9999 were reported by other customers.
    reported = /(4444|9999)$/.test(digits);
    if (reported)
      reasons.push({
        code: 'reported_account',
        severity: 'high',
        message: 'Other customers reported this account for scams.',
      });
    if (!externalAccountName(digits))
      reasons.push({
        code: 'unknown_account',
        severity: 'medium',
        message: 'We could not confirm who owns this account.',
      });
  } else {
    for (const rule of SCAM_PHRASES) {
      if (rule.pattern.test(text))
        reasons.push({ code: rule.code, severity: rule.severity, message: rule.message });
    }
    for (const raw of text.match(/\b(?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?/gi) ??
      []) {
      const link = raw.toLowerCase();
      const host = link.replace(/^https?:\/\//, '').split('/')[0]!;
      if (OUR_DOMAINS.test(host)) continue;
      if (SHORTENERS.test(host))
        reasons.push({
          code: 'short_link',
          severity: 'medium',
          message: 'Short links hide where they really go.',
        });
      else if (/nem|bank|cbn|bvn/.test(host))
        reasons.push({
          code: 'lookalike_domain',
          severity: 'high',
          message: `${host} is not a Nem website.`,
        });
      if (link.startsWith('http://'))
        reasons.push({
          code: 'insecure_link',
          severity: 'medium',
          message: 'The link is not secure (http).',
        });
    }
  }
  const score = Math.min(
    1,
    reasons.reduce((s, r) => s + (r.severity === 'high' ? 0.45 : 0.2), 0.02),
  );
  const verdict = score >= 0.6 ? 'likely_scam' : score >= 0.3 ? 'suspicious' : 'looks_safe';
  return {
    verdict,
    score: Math.round(score * 100) / 100,
    reasons,
    advice:
      verdict === 'likely_scam'
        ? 'Do not reply, click or send money. Block the sender and report it from Support.'
        : verdict === 'suspicious'
          ? 'Be careful. Contact the person or company through a number you already trust.'
          : 'We found no warning signs, but never share your PIN or OTP with anyone.',
    reported_account: reported,
  };
}

export function processLimitIncreases(bank: MockBank): boolean {
  const pending = bank.world.selfLimits.pending;
  if (!pending || pending.effectiveAt > bank.nowIso()) return false;
  bank.world.selfLimits = { daily: pending.daily, single: pending.single, pending: null };
  bank.notify({
    category: 'security',
    title: 'Your new limits are active',
    body: 'The higher limits you asked for 24 hours ago now apply.',
    deep_link: 'nembank://security/limits',
  });
  return true;
}

export function securityRepo(bank: MockBank): SecurityRepo {
  const limitsView = (): Schema<'SelfLimits'> => {
    const s = bank.world.selfLimits;
    return {
      daily_limit: s.daily,
      single_limit: s.single,
      kyc_daily_cap: api(KYC_TIERS[bank.tier()].dailyLimit),
      pending_increase: s.pending
        ? {
            daily_limit: s.pending.daily,
            single_limit: s.pending.single,
            effective_at: s.pending.effectiveAt,
          }
        : null,
    };
  };
  const panicView = (): Schema<'PanicState'> => ({
    active: bank.world.panic.active,
    activated_at: bank.world.panic.activatedAt,
    cards_frozen: bank.world.panic.frozenCardIds.length,
    outgoing_blocked: bank.world.panic.active,
  });
  return {
    async getCheckup() {
      const w = bank.world;
      const done: Record<Schema<'CheckupItem'>['id'], boolean> = {
        pin_set: bank.user.has_pin,
        kyc_tier_2: bank.tier() >= 2,
        biometrics_on: w.auth.biometricsOn,
        security_question_set: w.auth.securityQuestion !== null,
        duress_pin_set: w.auth.duressPin !== null,
        self_limit_set: w.selfLimits.daily !== null,
        single_device: w.devices.length === 1,
        alerts_on: w.alertPreferences.login_alerts && w.alertPreferences.new_device_alerts,
      };
      const items = CHECKUP.map((i) => ({ ...i, done: done[i.id] }));
      return { score: items.filter((i) => i.done).reduce((s, i) => s + i.points, 0), items };
    },
    async listSessions() {
      return {
        data: [...bank.world.sessions].sort((a, b) =>
          b.last_active_at.localeCompare(a.last_active_at),
        ),
      };
    },
    async revokeSession({ path }) {
      const s = bank.world.sessions.find((x) => x.id === path.session_id);
      if (!s) throw problem(404, 'not_found', 'Session not found');
      if (s.current) throw problem(409, 'invalid_state', 'Sign out instead to end this session');
      bank.world.sessions = bank.world.sessions.filter((x) => x.id !== path.session_id);
    },
    async getLimits() {
      return limitsView();
    },
    async setLimits({ body, stepUpToken }) {
      const cap = KYC_TIERS[bank.tier()].dailyLimit;
      const daily = body.daily_limit ? positive(body.daily_limit, 'NGN') : null;
      const single = body.single_limit ? positive(body.single_limit, 'NGN') : null;
      if ((daily && daily.amount > cap.amount) || (single && single.amount > cap.amount)) {
        throw problem(422, 'limit_exceeded', 'Your limits must stay below your KYC cap');
      }
      if (daily && single && single.amount > daily.amount) {
        throw problem(422, 'validation_failed', 'The single limit cannot be above the daily limit');
      }
      const current = bank.world.selfLimits;
      // Removing a limit (null) or raising one loosens protection, so it waits.
      const raises = (next: typeof daily, now: Schema<'Money'> | null) =>
        now !== null && (next === null || next.amount > fromApi(now).amount);
      const loosens = raises(daily, current.daily) || raises(single, current.single);
      const value = { daily: body.daily_limit, single: body.single_limit };
      if (!loosens || bank.hasValidStepUp(stepUpToken, 'limit_increase')) {
        bank.world.selfLimits = { ...value, pending: null };
      } else {
        current.pending = {
          ...value,
          effectiveAt: addMinutes(bank.now(), LIMIT_INCREASE_DELAY_HOURS * 60).toISOString(),
        };
      }
      return limitsView();
    },
    async getPanic() {
      return panicView();
    },
    async activatePanic() {
      const panic = bank.world.panic;
      if (!panic.active) {
        panic.active = true;
        panic.activatedAt = bank.nowIso();
        panic.frozenCardIds = [];
        for (const card of bank.world.cards) {
          if (card.status !== 'active') continue;
          card.status = 'frozen';
          card.frozen_by_panic = true;
          panic.frozenCardIds.push(card.id);
        }
        bank.notify({
          category: 'security',
          title: 'Panic mode is on',
          body: 'Your cards are frozen and no money can leave your account.',
          deep_link: 'nembank://security',
        });
      }
      return panicView();
    },
    async releasePanic({ stepUpToken }) {
      bank.consumeStepUp(stepUpToken, 'unfreeze');
      const panic = bank.world.panic;
      for (const card of bank.world.cards) {
        if (card.frozen_by_panic && panic.frozenCardIds.includes(card.id)) {
          card.frozen_by_panic = false;
          if (card.status === 'frozen') card.status = 'active';
        }
      }
      bank.world.panic = { active: false, activatedAt: null, frozenCardIds: [] };
      return panicView();
    },
    async setDuressPin({ body, stepUpToken }) {
      bank.consumeStepUp(stepUpToken, 'pin_reset');
      assertStrongPin(body.pin);
      if (body.pin === bank.world.auth.pin) {
        throw problem(422, 'validation_failed', 'Your duress PIN must be different from your PIN');
      }
      bank.world.auth.duressPin = body.pin;
    },
    async removeDuressPin({ stepUpToken }) {
      bank.consumeStepUp(stepUpToken, 'pin_reset');
      bank.world.auth.duressPin = null;
    },
    async setSecurityQuestion({ body }) {
      if (body.answer.trim().length < 3)
        throw problem(422, 'validation_failed', 'Use an answer of 3 characters or more');
      bank.world.auth.securityQuestion = {
        question: body.question.trim(),
        answer: body.answer.trim().toLowerCase(),
      };
    },
    async checkScam({ body }) {
      return {
        ...checkScam(body),
        ai: {
          feature: 'scam_checker',
          model_version: 'rules-mock-1',
          explanation:
            'Checks the text against known scam patterns, link tricks and reported accounts.',
          fallback_used: true,
        },
      };
    },
    async getAlerts() {
      return bank.world.alertPreferences;
    },
    async setAlerts({ body }) {
      fromApi(body.transaction_alert_threshold);
      bank.world.alertPreferences = body;
      return body;
    },
  };
}
