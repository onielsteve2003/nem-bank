import type { Outcome } from './confirm';

// "Why was this held?" (AI-1): the risk engine's decision in plain words. The
// bank sends the reasons; this adds what each one means and what happens next,
// so a held payment never feels like a black box.

export type RiskBand = { label: string; level: 'low' | 'medium' | 'high' };

/** The score in words. Same cut-offs as the scam checker: 0.3 and 0.6. */
export function riskBand(score: number): RiskBand {
  if (score >= 0.6) return { label: 'High risk', level: 'high' };
  if (score >= 0.3) return { label: 'Medium risk', level: 'medium' };
  return { label: 'Low risk', level: 'low' };
}

/** "86 out of 100", which reads better than a decimal. */
export const scoreOutOf100 = (score: number) => Math.round(score * 100);

const REASON_HELP: Record<string, string> = {
  large_amount:
    'Big payments are what fraudsters go after, so the first one this size gets a second pair of eyes.',
  unusual_amount:
    'Someone who took over an account usually sends much more than its owner does. A quick check rules that out.',
  new_device:
    'Most account takeovers start on a new phone. For the first day, bigger payments need one more check.',
  new_beneficiary:
    'Scammers push people to pay someone new, fast. A short wait gives you time to be sure.',
  velocity: 'Many payments in a short time can mean someone else is emptying the account.',
  reported_account: 'Other customers told us this account was used in a scam.',
};

export const reasonHelp = (code: string) =>
  REASON_HELP[code] ?? 'Our checks noticed something unusual about this payment.';

/** What happens from here, in order, for a payment that is waiting. */
export function nextSteps(outcome: Outcome): string[] {
  switch (outcome) {
    case 'held':
      return [
        'The money is put aside in your account. It has not left.',
        'Someone at Nem looks at the payment, usually within minutes.',
        'We tell you straight away: it goes, or the money comes back to your balance.',
      ];
    case 'step_up':
      return [
        'Nothing has left your account.',
        'Enter the code we email you to show it is really you.',
        'The payment then goes at once. You can cancel it instead.',
      ];
    case 'delayed':
      return [
        'The money is put aside in your account. It has not left.',
        'The payment goes by itself when the wait ends.',
        'Changed your mind, or someone is rushing you? Cancel it before then.',
      ];
    default:
      return [];
  }
}

/** Only these outcomes have something to explain. */
export const isWaitingOutcome = (o: Outcome) => o === 'held' || o === 'step_up' || o === 'delayed';

export const HOLD_TITLE: Partial<Record<Outcome, string>> = {
  held: 'Why was this held?',
  step_up: 'Why do I need to confirm?',
  delayed: 'Why is this waiting?',
};
