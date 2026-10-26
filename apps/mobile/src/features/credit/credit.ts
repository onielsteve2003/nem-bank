import type { Schema } from '@nem/contracts';
import { CircleAlert, CircleCheck, Info, type LucideIcon } from 'lucide-react-native';

import type { Tone } from '@/components';

type Eligibility = Schema<'CreditEligibility'>;
type Reason = Schema<'ReasonCode'>;

/** Score bands from worst to best, for the four-step meter. */
export const SCORE_BANDS: { value: Eligibility['score_band']; label: string; tone: Tone }[] = [
  { value: 'poor', label: 'Poor', tone: 'danger' },
  { value: 'fair', label: 'Fair', tone: 'warning' },
  { value: 'good', label: 'Good', tone: 'success' },
  { value: 'excellent', label: 'Excellent', tone: 'success' },
];

export const bandIndex = (band: Eligibility['score_band']) =>
  SCORE_BANDS.findIndex((b) => b.value === band);

export const IMPACT: Record<
  Reason['impact'],
  { icon: LucideIcon; color: 'success' | 'warning' | 'textMuted'; label: string }
> = {
  positive: { icon: CircleCheck, color: 'success', label: 'Helps' },
  negative: { icon: CircleAlert, color: 'warning', label: 'Holds you back' },
  neutral: { icon: Info, color: 'textMuted', label: 'Noted' },
};

/** What helps first, then what holds the customer back, then the rest. */
export function sortReasons(reasons: readonly Reason[]): Reason[] {
  const order: Record<Reason['impact'], number> = { positive: 0, negative: 1, neutral: 2 };
  return [...reasons].sort((a, b) => order[a.impact] - order[b.impact]);
}

/** The one thing to do next when the customer cannot borrow, from the reason codes. */
export function nextStep(reasons: readonly Reason[]): 'kyc' | 'repay' | 'income' | null {
  if (reasons.some((r) => r.code === 'kyc_tier')) return 'kyc';
  if (reasons.some((r) => r.code === 'active_loan')) return 'repay';
  if (reasons.some((r) => r.code === 'no_salary')) return 'income';
  return null;
}
