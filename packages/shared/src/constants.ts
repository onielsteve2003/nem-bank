import { money, type Money } from './money';

// Demo values based on public CBN guidance (PRD FR-KYC, TRF-4). They are configurable
// from the console (ADM-8) and are labelled as demo values in the app.

const naira = (major: number): Money => money(BigInt(major) * 100n, 'NGN');

export type KycTier = 1 | 2 | 3;

export interface KycTierRule {
  readonly tier: KycTier;
  readonly requirements: readonly string[];
  readonly dailyLimit: Money;
  /** `null` means no maximum balance. */
  readonly maxBalance: Money | null;
}

export const KYC_TIERS: Readonly<Record<KycTier, KycTierRule>> = {
  1: {
    tier: 1,
    requirements: ['Name', 'Phone', 'Email', 'Date of birth'],
    dailyLimit: naira(50_000),
    maxBalance: naira(300_000),
  },
  2: {
    tier: 2,
    requirements: ['BVN or NIN'],
    dailyLimit: naira(200_000),
    maxBalance: naira(500_000),
  },
  3: {
    tier: 3,
    requirements: ['Government ID', 'Selfie', 'Address'],
    dailyLimit: naira(5_000_000),
    maxBalance: null,
  },
};

/** Foreign-currency wallets and cards need Tier 2; credit needs Tier 3 (KYC-7). */
export const MIN_TIER_FOR = { fxWallets: 2, cards: 2, credit: 3 } as const satisfies Record<
  string,
  KycTier
>;

export type TransferKind = 'internal' | 'external';

/** External transfer fee bands: the first band whose `upTo` covers the amount applies. */
export const EXTERNAL_TRANSFER_FEE_BANDS: readonly { upTo: Money | null; fee: Money }[] = [
  { upTo: naira(5_000), fee: naira(10) },
  { upTo: naira(50_000), fee: naira(25) },
  { upTo: null, fee: naira(50) },
];

export function transferFee(amount: Money, kind: TransferKind): Money {
  if (amount.currency !== 'NGN') throw new RangeError('Transfer fees are defined for NGN only');
  if (kind === 'internal') return naira(0);
  const band = EXTERNAL_TRANSFER_FEE_BANDS.find(
    (b) => b.upTo === null || amount.amount <= b.upTo.amount,
  );
  if (!band) throw new Error('Fee bands must end with an open-ended band');
  return band.fee;
}

/** Electronic Money Transfer Levy: ₦50 on NGN inflows of ₦10,000 or more. */
export const EMTL = { threshold: naira(10_000), levy: naira(50) } as const;

export function emtlFor(inflow: Money): Money {
  return inflow.currency === 'NGN' && inflow.amount >= EMTL.threshold.amount
    ? EMTL.levy
    : money(0n, inflow.currency);
}

/** FX quotes are honoured for 60 seconds (FX-1). */
export const FX_QUOTE_TTL_SECONDS = 60;
