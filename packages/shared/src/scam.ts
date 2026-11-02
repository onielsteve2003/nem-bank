// On-device scam rules (AI-2): Nigerian scam patterns, link tricks and urgency
// cues. They run with no network and no model, so they are the scam checker's
// fallback and the source of the inline warnings while someone types a payment.
// Reasons use the contract's RiskReason shape so screens show them as they are.

export type ScamSeverity = 'low' | 'medium' | 'high';
export type ScamVerdict = 'looks_safe' | 'suspicious' | 'likely_scam';

export interface ScamReason {
  code: string;
  severity: ScamSeverity;
  message: string;
}

export interface ScamCheck {
  verdict: ScamVerdict;
  /** 0 (no signs) to 1 (many strong signs), two decimals. */
  score: number;
  reasons: ScamReason[];
  advice: string;
}

interface Rule extends ScamReason {
  pattern: RegExp;
}

/** Patterns in a message someone sent you. English and Pidgin wording both count. */
export const MESSAGE_RULES: readonly Rule[] = [
  {
    code: 'asks_for_secret',
    severity: 'high',
    pattern: /\b(otp|one[- ]time (pass)?code|pin|cvv|token code|password)\b/i,
    message: 'It asks for a PIN, OTP or card code. No bank ever asks for these.',
  },
  {
    code: 'bvn_update',
    severity: 'high',
    pattern: /\b(bvn|nin)\b.{0,60}\b(update|link|verify|validate|block|expire)/i,
    message: '"Update your BVN or NIN" messages are a common scam.',
  },
  {
    code: 'impersonation',
    severity: 'high',
    pattern:
      /\b(cbn|efcc|central bank|customer care|account officer|nem (support|team)|head office)\b/i,
    message: 'It claims to be a bank or an agency. They never message you for money or codes.',
  },
  {
    code: 'wrong_transfer',
    severity: 'high',
    pattern:
      /\b(sent|transferred|paid)\b.{0,40}\b(by mistake|in error|wrongly)\b|\bsend (it|am) back\b/i,
    message:
      '"I sent money to you by mistake" is a known trick. Let your bank reverse it, never refund it yourself.',
  },
  {
    code: 'advance_fee',
    severity: 'high',
    pattern:
      /\b(send|pay|transfer)\b.{0,30}\b(first|fee|charge|to claim|to receive|to unlock|to release)\b|\b(processing|clearance|customs|activation|release) fee\b/i,
    message: 'It asks you to pay first to receive money.',
  },
  {
    code: 'family_emergency',
    severity: 'high',
    pattern:
      /\b(this is my new (number|line)|my (phone|number) (got|was) (spoilt|stolen|lost)|i('m| am) stranded|i don stuck)\b/i,
    message:
      'A "new number" or emergency from family is often a scam. Call their old number first.',
  },
  {
    code: 'threat',
    severity: 'medium',
    pattern: /\b(blocked|suspended|restricted|deactivated|frozen|arrest(ed)?)\b/i,
    message: 'It threatens you to rush you.',
  },
  {
    code: 'urgency',
    severity: 'medium',
    pattern:
      /\b(urgent(ly)?|immediately|within 24 ?h(ou)?rs?|right now|asap|sharp sharp|quick quick)\b/i,
    message: 'It pushes you to act fast.',
  },
  {
    code: 'prize',
    severity: 'medium',
    pattern: /\b(you('ve| have)? won|winner|prize|promo|giveaway|lottery|lucky draw)\b/i,
    message: 'Prizes you did not enter for are a classic scam.',
  },
  {
    code: 'investment',
    severity: 'medium',
    pattern:
      /\b(double your money|guaranteed (returns?|profit)|\d{2,3}% (profit|returns?|interest)|forex|crypto|ponzi|invest(ment)? plan)\b/i,
    message: 'Guaranteed or doubled returns are a red flag.',
  },
  {
    code: 'job_or_loan',
    severity: 'medium',
    pattern: /\b(loan (is )?approved|job offer|you('ve| have) been (selected|shortlisted))\b/i,
    message: 'Loans or jobs you did not apply for often end in a fee.',
  },
  {
    code: 'secrecy',
    severity: 'medium',
    pattern:
      /\b(don'?t tell (anyone|anybody)|keep (this|it) (secret|between us)|no tell anybody)\b/i,
    message: 'It asks you to keep it secret.',
  },
];

const LINK =
  /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?|\bhttps?:\/\/\d{1,3}(?:\.\d{1,3}){3}\S*/gi;
const SHORTENERS = /^(bit\.ly|tinyurl\.com|t\.co|cutt\.ly|is\.gd|rb\.gy|shorturl\.at|tiny\.cc)$/i;
const BRAND_WORDS = /nem|bank|cbn|bvn|nin|verify|secure|login/;

/** Hosts that really are Nem's; everything else with a bank-ish name is a lookalike. */
export const NEM_DOMAINS: readonly string[] = ['nem-bank-fodx.vercel.app'];

const isOurs = (host: string) => NEM_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));

/** Every link in the text, checked for the usual tricks. */
export function linkReasons(text: string): ScamReason[] {
  const reasons: ScamReason[] = [];
  for (const raw of text.match(LINK) ?? []) {
    const link = raw.toLowerCase();
    const host = link.replace(/^https?:\/\//, '').split(/[/?#]/)[0]!;
    if (isOurs(host)) continue;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      reasons.push({
        code: 'ip_link',
        severity: 'high',
        message: 'The link is a bare number address, which real companies do not use.',
      });
    } else if (host.split('.').some((part) => part.startsWith('xn--'))) {
      reasons.push({
        code: 'disguised_link',
        severity: 'high',
        message: `${host} uses look-alike letters to copy a real website.`,
      });
    } else if (SHORTENERS.test(host)) {
      reasons.push({
        code: 'short_link',
        severity: 'medium',
        message: 'Short links hide where they really go.',
      });
    } else if (BRAND_WORDS.test(host)) {
      reasons.push({
        code: 'lookalike_domain',
        severity: 'high',
        message: `${host} is not a Nem website.`,
      });
    }
    if (link.startsWith('http://')) {
      reasons.push({
        code: 'insecure_link',
        severity: 'medium',
        message: 'The link is not secure (http).',
      });
    }
  }
  return reasons;
}

/** Each rule says its reason once, however often it matches. */
const unique = (reasons: ScamReason[]) =>
  reasons.filter((r, i) => reasons.findIndex((x) => x.code === r.code) === i);

const WEIGHT: Record<ScamSeverity, number> = { low: 0.1, medium: 0.2, high: 0.45 };

export const SCAM_ADVICE: Record<ScamVerdict, string> = {
  likely_scam: 'Do not reply, click or send money. Block the sender and report it from Support.',
  suspicious: 'Be careful. Contact the person or company through a number you already trust.',
  looks_safe: 'We found no warning signs, but never share your PIN or OTP with anyone.',
};

/** Reasons → score and verdict. Two strong signs, or one strong and one weaker, is likely a scam. */
export function scamResult(reasons: ScamReason[]): ScamCheck {
  const score = Math.min(
    1,
    reasons.reduce((s, r) => s + WEIGHT[r.severity], 0.02),
  );
  const verdict: ScamVerdict =
    score >= 0.6 ? 'likely_scam' : score >= 0.3 ? 'suspicious' : 'looks_safe';
  return { verdict, score: Math.round(score * 100) / 100, reasons, advice: SCAM_ADVICE[verdict] };
}

/** Check a message or a link someone sent you. */
export function checkScamText(text: string): ScamCheck {
  const t = text.trim();
  const reasons = MESSAGE_RULES.filter((r) => r.pattern.test(t)).map(
    ({ pattern: _p, ...reason }) => reason,
  );
  return scamResult(unique([...reasons, ...linkReasons(t)]));
}

/**
 * What the customer types as the reason for a payment can give away that
 * someone is pushing them into it. One warning, the strongest, or null.
 */
const NARRATION_RULES: readonly Rule[] = [
  {
    code: 'pay_to_receive',
    severity: 'high',
    pattern:
      /\b(processing|clearance|customs|activation|release|unlock(ing)?|registration|delivery) (fee|charge)s?\b|\bto (claim|release|unlock)\b/i,
    message: 'Paying a fee to receive money, a prize or a parcel is how most scams work.',
  },
  {
    code: 'refund_request',
    severity: 'high',
    pattern: /\b(refund|reversal|send(ing)? back)\b.{0,30}\b(mistake|error|wrong)/i,
    message: 'If someone says they sent you money by mistake, let the bank reverse it instead.',
  },
  {
    code: 'account_fix',
    severity: 'high',
    pattern: /\b(bvn|nin|account) (update|upgrade|verification|unblock|reactivation)\b/i,
    message: 'No bank asks you to pay to update or unblock your account.',
  },
  {
    code: 'investment',
    severity: 'medium',
    pattern: /\b(invest(ment)?|double|forex|crypto|trading|profit)\b/i,
    message: 'Check any investment with the SEC before you pay. Guaranteed returns are a red flag.',
  },
];

export function narrationWarning(narration: string): ScamReason | null {
  const rule = NARRATION_RULES.find((r) => r.pattern.test(narration));
  if (!rule) return null;
  const { pattern: _p, ...reason } = rule;
  return reason;
}

/** An account name that pretends to be a bank, an agency or a refund desk. */
const OFFICIAL_NAME =
  /\b(cbn|efcc|central bank|customer (care|service)|support|refund|verification|helpdesk|help desk|security team|nem bank)\b/i;

export function recipientWarning(name: string): ScamReason | null {
  if (!OFFICIAL_NAME.test(name)) return null;
  return {
    code: 'official_sounding_name',
    severity: 'high',
    message:
      'This name sounds like a bank or an agency. They never ask you to send money to fix your account.',
  };
}
