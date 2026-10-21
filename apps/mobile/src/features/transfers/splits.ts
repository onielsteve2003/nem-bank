import type { Schema } from '@nem/contracts';
import { SPLIT_REMIND_HOURS } from '@nem/shared';

type SplitBill = Schema<'SplitBill'>;
type SplitShare = Schema<'SplitShare'>;

export const SPLIT_TITLE_MAX_LENGTH = 60;
const REMIND_EVERY_MS = SPLIT_REMIND_HOURS * 60 * 60_000;

/**
 * A typed naira amount ("12,500", "₦ 3000.5") as kobo, or null if it is not a
 * positive amount with at most two decimals.
 */
export function parseNairaText(input: string): bigint | null {
  const clean = input.replace(/[₦,\s]/g, '');
  const match = /^(\d{1,12})(?:\.(\d{0,2}))?$/.exec(clean);
  if (!match) return null;
  const kobo = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  return kobo > 0n ? kobo : null;
}

/** The share of the total already paid, 0 to 1, for the progress bar. */
export function paidFraction(split: SplitBill): number {
  const total = BigInt(split.total.amount_minor);
  if (total === 0n) return 0;
  const paid = BigInt(split.paid_total.amount_minor);
  // Basis points keep the bigint division exact enough for a bar.
  return Number((paid * 10_000n) / total) / 10_000;
}

/** Friends' shares only: the creator's own share is paid the moment the bill is. */
export const friendShares = (split: SplitBill) =>
  split.shares.filter((s) => s.money_request_id !== null);

export function paidCount(split: SplitBill) {
  const friends = friendShares(split);
  return { paid: friends.filter((s) => s.status === 'paid').length, of: friends.length };
}

/** Whether this person can be nudged now: still to pay and not reminded in the last day. */
export function canRemind(share: SplitShare, now: number = Date.now()): boolean {
  if (share.status !== 'pending' || !share.money_request_id) return false;
  return !share.last_reminded_at || now - Date.parse(share.last_reminded_at) >= REMIND_EVERY_MS;
}

/** How many people a reminder would go to now. */
export const remindable = (split: SplitBill, now: number = Date.now()) =>
  split.shares.filter((s) => canRemind(s, now)).length;

/** "Reminded 5 min ago", "Reminded 3 h ago", for a share still to pay. */
export function remindedAgo(at: string, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
  if (minutes < 1) return 'Reminded just now';
  if (minutes < 60) return `Reminded ${minutes} min ago`;
  return `Reminded ${Math.round(minutes / 60)} h ago`;
}

export const isSettled = (split: SplitBill) =>
  friendShares(split).every((s) => s.status !== 'pending');
