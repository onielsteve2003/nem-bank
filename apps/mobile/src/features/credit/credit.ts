import type { Schema } from '@nem/contracts';
import { CircleAlert, CircleCheck, Info, type LucideIcon } from 'lucide-react-native';

import type { Tone } from '@/components';
import i18n, { withLabel } from '@/lib/i18n';

type Eligibility = Schema<'CreditEligibility'>;
type Reason = Schema<'ReasonCode'>;

/** Score bands from worst to best, for the four-step meter. */
export const SCORE_BANDS: { value: Eligibility['score_band']; label: string; tone: Tone }[] = [
  withLabel('credit.bands.poor', { value: 'poor', tone: 'danger' }),
  withLabel('credit.bands.fair', { value: 'fair', tone: 'warning' }),
  withLabel('credit.bands.good', { value: 'good', tone: 'success' }),
  withLabel('credit.bands.excellent', { value: 'excellent', tone: 'success' }),
];

export const bandIndex = (band: Eligibility['score_band']) =>
  SCORE_BANDS.findIndex((b) => b.value === band);

export const IMPACT: Record<
  Reason['impact'],
  { icon: LucideIcon; color: 'success' | 'warning' | 'textMuted'; label: string }
> = {
  positive: withLabel('credit.impact.positive', { icon: CircleCheck, color: 'success' }),
  negative: withLabel('credit.impact.negative', { icon: CircleAlert, color: 'warning' }),
  neutral: withLabel('credit.impact.neutral', { icon: Info, color: 'textMuted' }),
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

/** Loan amounts move in ₦5,000 steps, from ₦5,000 up to what the customer may borrow. */
export const AMOUNT_STEP_KOBO = 500_000n;

/** How many amount steps fit under `maxKobo` (0 when not even one does). */
export const amountSteps = (maxKobo: bigint) => Number(maxKobo / AMOUNT_STEP_KOBO);

/** Slider index → amount in kobo: index 0 is one step. */
export const amountAt = (index: number) => BigInt(index + 1) * AMOUNT_STEP_KOBO;

export const TENORS = [30, 60, 90, 180] as const;
export type Tenor = (typeof TENORS)[number];

/** 30 → "1 month", 180 → "6 months": every instalment is 30 days apart. */
export const tenorLabel = (days: number) =>
  i18n.t('common.months', { count: Math.round(days / 30) });

/** 2400 → "24%", 2650 → "26.5%". */
export const aprLabel = (bps: number) => `${bps / 100}%`;

type Loan = Schema<'Loan'>;

export const LOAN_STATUS: Record<Loan['status'], { label: string; tone: Tone }> = {
  active: withLabel('credit.loanStatus.active', { tone: 'success' }),
  overdue: withLabel('credit.loanStatus.overdue', { tone: 'danger' }),
  repaid: withLabel('credit.loanStatus.repaid', { tone: 'neutral' }),
  defaulted: withLabel('credit.loanStatus.defaulted', { tone: 'danger' }),
};

/** Everything the customer repays: the sum of the schedule. */
export const loanTotalKobo = (loan: Loan) =>
  loan.schedule.reduce((sum, i) => sum + BigInt(i.amount.amount_minor), 0n);

/** Whole percent of the total already repaid, rounded down so it never shows 100% early. */
export function repaidPct(loan: Loan): number {
  const total = loanTotalKobo(loan);
  if (total === 0n) return 100;
  const paid = total - BigInt(loan.outstanding.amount_minor);
  return Number((paid * 100n) / total);
}

/** The loan still being repaid, if there is one. */
export const currentLoan = (loans: readonly Loan[]) => loans.find((l) => l.status !== 'repaid');

const leftOn = (i: Schema<'Installment'>) =>
  BigInt(i.amount.amount_minor) - BigInt(i.paid.amount_minor);

/** What is owed right now: every instalment that is due today or overdue. */
export const dueNowKobo = (loan: Loan) =>
  loan.schedule
    .filter((i) => i.status === 'due' || i.status === 'overdue')
    .reduce((sum, i) => sum + leftOn(i), 0n);

/** What is left on the next unpaid instalment (0 when the loan is repaid). */
export const nextLeftKobo = (loan: Loan) => (loan.next_due ? leftOn(loan.next_due) : 0n);
