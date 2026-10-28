import type { Schema } from '@nem/contracts';
import type { KycTier } from '@nem/shared';
import type { Href } from 'expo-router';

type Overview = Schema<'KycOverview'>;
type Unlock = NonNullable<Schema<'TierInfo'>['unlocks']>[number];

/** What a tier unlocks, in words. */
export const UNLOCK_LABELS: Record<Unlock, string> = {
  fx_wallets: 'Dollar, pound and euro wallets',
  usd_cards: 'Dollar cards',
  credit: 'Loans',
  higher_limits: 'Higher limits',
};

/** Where you stand, in one sentence. */
export function kycStatusText(overview: Overview): string {
  switch (overview.status) {
    case 'pending_review':
      return 'Your documents are being reviewed. This usually takes a few minutes.';
    case 'rejected':
      return 'Your last upgrade wasn’t approved.';
    case 'resubmit':
      return 'We need some documents again.';
    default:
      return overview.tier === 3
        ? 'You’re fully verified.'
        : 'Verify a little more to raise your limits.';
  }
}

/** The tier above yours, or null at the top. */
export const nextTier = (tier: KycTier): KycTier | null =>
  tier < 3 ? ((tier + 1) as KycTier) : null;

/** The flow that reaches each tier. A tier without one is not built yet. */
const UPGRADE_ROUTES: Partial<Record<KycTier, Href>> = {};

/**
 * The screen that takes you to the next tier. `null` means there is nothing to
 * start: you are at the top, your documents are with a reviewer, or the flow
 * is not built yet.
 */
export function upgradeHref(overview: Overview): Href | null {
  const next = nextTier(overview.tier);
  if (!next || overview.status === 'pending_review') return null;
  return UPGRADE_ROUTES[next] ?? null;
}
