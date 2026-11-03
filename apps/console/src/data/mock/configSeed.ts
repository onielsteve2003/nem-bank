import type { Schema } from '@nem/contracts';
import { EMTL, EXTERNAL_TRANSFER_FEE_BANDS, KYC_TIERS, type Money } from '@nem/shared';

// The live bank configuration (ADM-8), seeded from the same constants the app uses,
// and the feature flags, including the paid-feature toggles (PRD §11).

export type BankConfig = Schema<'BankConfig'>;
export type FeatureFlag = Schema<'FeatureFlag'>;

const dto = (m: Money) => ({ amount_minor: m.amount.toString(), currency: m.currency });
const naira = (major: number) => ({ amount_minor: String(major * 100), currency: 'NGN' as const });

export function seedConfig(): BankConfig {
  return {
    version: 7,
    fees: {
      internal_transfer: naira(0),
      external_transfer_bands: EXTERNAL_TRANSFER_FEE_BANDS.map((b) => ({
        up_to: b.upTo ? dto(b.upTo) : null,
        fee: dto(b.fee),
      })),
      emtl: dto(EMTL.levy),
      emtl_threshold: dto(EMTL.threshold),
    },
    limits: Object.values(KYC_TIERS).map((t) => ({
      tier: t.tier,
      daily_limit: dto(t.dailyLimit),
      max_balance: t.maxBalance ? dto(t.maxBalance) : null,
    })),
    fx_spreads_bps: { 'USD-NGN': 150, 'GBP-NGN': 175, 'EUR-NGN': 175 },
    cooling_off: { new_beneficiary_threshold: naira(100_000), delay_minutes: 30 },
    new_device: { cool_off_hours: 24, daily_limit: naira(50_000) },
    updated_at: '2026-10-30T10:00:00Z',
  };
}

const IFEOMA = { id: '01900000-0000-7000-8000-00000000a001', name: 'Ifeoma Adeyemi' };

const FLAGS: [key: string, description: string, enabled: boolean, paid: boolean][] = [
  ['real_money_mode', 'Real accounts and money through a licensed BaaS partner.', false, true],
  ['international_transfers', 'Send abroad through a licensed remittance partner.', false, true],
  ['physical_cards', 'Order a printed debit card, delivered by courier.', false, true],
  ['sms_otp', 'One-time codes by SMS as well as email.', false, true],
  ['ussd_banking', 'Bank with *code# on any phone, no data needed.', false, true],
  [
    'assistant_llm',
    'Answer assistant questions with the free LLM tier (rules when off).',
    true,
    false,
  ],
  [
    'fraud_model_scoring',
    'Score transfers with the fraud model as well as the rules.',
    true,
    false,
  ],
  [
    'scam_warnings',
    'Warn customers when a transfer narration looks like a scam script.',
    true,
    false,
  ],
  ['ajo_groups', 'Let customers start and join ajo savings groups.', true, false],
  ['credit_offers', 'Show pre-approved loan offers to Tier 3 customers.', true, false],
  [
    'paystack_test_mode',
    'Route transfers to other banks through Paystack test mode.',
    false,
    false,
  ],
];

export function seedFlags(): Map<string, FeatureFlag> {
  return new Map(
    FLAGS.map(([key, description, enabled, paid]) => [
      key,
      {
        key,
        description,
        enabled,
        paid_feature: paid,
        updated_at: '2026-10-28T09:00:00Z',
        updated_by: paid ? null : IFEOMA,
      },
    ]),
  );
}
