import type { Outcome } from './confirm';
import i18n, { localized } from '@/lib/i18n';

// "Why was this held?" (AI-1): the risk engine's decision in plain words. The
// bank sends the reasons; this adds what each one means and what happens next,
// so a held payment never feels like a black box.

export type RiskBand = { label: string; level: 'low' | 'medium' | 'high' };

/** The score in words. Same cut-offs as the scam checker: 0.3 and 0.6. */
export function riskBand(score: number): RiskBand {
  const level = score >= 0.6 ? 'high' : score >= 0.3 ? 'medium' : 'low';
  return { label: i18n.t(`transfers.hold.risk.${level}`), level };
}

/** "86 out of 100", which reads better than a decimal. */
export const scoreOutOf100 = (score: number) => Math.round(score * 100);

const KNOWN_REASONS = [
  'large_amount',
  'unusual_amount',
  'new_device',
  'new_beneficiary',
  'velocity',
  'reported_account',
] as const;
type KnownReason = (typeof KNOWN_REASONS)[number];

export const reasonHelp = (code: string) =>
  (KNOWN_REASONS as readonly string[]).includes(code)
    ? i18n.t(`transfers.hold.reasons.${code as KnownReason}`)
    : i18n.t('transfers.hold.reasons.unknown');

/** What happens from here, in order, for a payment that is waiting. */
export function nextSteps(outcome: Outcome): string[] {
  switch (outcome) {
    case 'held':
    case 'step_up':
    case 'delayed':
      return i18n.t(`transfers.hold.steps.${outcome}`, { returnObjects: true });
    default:
      return [];
  }
}

/** Only these outcomes have something to explain. */
export const isWaitingOutcome = (o: Outcome) => o === 'held' || o === 'step_up' || o === 'delayed';

export const HOLD_TITLE: Partial<Record<Outcome, string>> = localized({
  held: 'transfers.hold.titles.held',
  step_up: 'transfers.hold.titles.step_up',
  delayed: 'transfers.hold.titles.delayed',
});
