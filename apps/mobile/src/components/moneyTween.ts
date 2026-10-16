import { divideRounded, money, type Money } from '@nem/shared';

const STEPS = 1000n;

/** Ease-out cubic: fast start, gentle landing, so the final digits settle rather than snap. */
export const easeOutCubic = (t: number): number => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

/**
 * The amount shown `progress` (0–1) of the way from `from` to `to`.
 * Progress is quantised to 1/1000 steps and the amount stays bigint, so no float
 * ever touches the money; each frame rounds half-up to a whole minor unit.
 * A currency change has no in-between value, so it jumps straight to `to`.
 */
export function interpolateMoney(from: Money, to: Money, progress: number): Money {
  if (from.currency !== to.currency || progress >= 1) return to;
  if (progress <= 0) return from;
  const step = BigInt(Math.round(progress * Number(STEPS)));
  const delta = divideRounded((to.amount - from.amount) * step, STEPS, 'half-up');
  return money(from.amount + delta, to.currency);
}
