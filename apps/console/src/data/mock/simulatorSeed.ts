import type { Schema } from '@nem/contracts';

import type { CustomerRecord } from './customerSeed';
import { customerId } from './customerSeed';

// Test cards the Merchant Simulator can charge (ADM-11), one for each decline path,
// and the sandbox interbank rail's settings. PANs are Luhn-valid on test BINs.

export interface SimCard {
  card: Schema<'Card'>;
  userId: string;
  pan: string;
  cvv: string;
  /** What the test card is for, shown beside it in the simulator. */
  purpose: string;
}

export interface SimCharge {
  tx: Schema<'CardTransaction'>;
  accountId: string;
  /** The amount held on the account, in the card's currency. */
  hold: bigint;
}

export type BankPartnerSettings = Schema<'BankPartnerSimulator'>;

export const DEFAULT_BANK_PARTNER: BankPartnerSettings = {
  failure_rate_bps: 200,
  min_delay_seconds: 1,
  max_delay_seconds: 8,
  name_check: 'realistic',
  timeout_rate_bps: 50,
};

function luhn(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let d = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return body + String((10 - (sum % 10)) % 10);
}

type Spec = {
  n: number;
  currency: 'NGN' | 'USD';
  type: Schema<'CardType'>;
  purpose: string;
  controls?: Partial<Schema<'CardControls'>>;
};

const SPECS: Spec[] = [
  {
    n: 1,
    currency: 'NGN',
    type: 'standard',
    purpose: 'Approves; ₦500,000 per transaction',
    controls: {
      spend_limit: {
        amount: { amount_minor: '50000000', currency: 'NGN' },
        period: 'per_transaction',
      },
    },
  },
  { n: 1, currency: 'USD', type: 'standard', purpose: 'Dollar card for foreign merchants' },
  {
    n: 2,
    currency: 'NGN',
    type: 'standard',
    purpose: 'Declines abroad (international off)',
    controls: { international_enabled: false },
  },
  { n: 5, currency: 'NGN', type: 'standard', purpose: 'Declines: the customer is frozen' },
  { n: 4, currency: 'NGN', type: 'single_use', purpose: 'Single use; low balance' },
  {
    n: 3,
    currency: 'NGN',
    type: 'merchant_locked',
    purpose: 'Works only at Netflix',
    controls: { merchant_lock: { merchant_id: 'netflix', merchant_name: 'Netflix' } },
  },
];

export function seedCards(customers: Map<string, CustomerRecord>): SimCard[] {
  return SPECS.map((spec, i) => {
    const record = customers.get(customerId(spec.n))!;
    const account = record.view.accounts.find((a) => a.currency === spec.currency)!;
    const pan = luhn(
      `${spec.currency === 'NGN' ? '506199' : '453219'}00000${String(i + 1).padStart(4, '0')}`,
    );
    return {
      userId: customerId(spec.n),
      pan,
      cvv: String(100 + i * 111).slice(0, 3),
      purpose: spec.purpose,
      card: {
        id: `01900000-0000-7000-8000-0000000ca${String(i + 1).padStart(3, '0')}`,
        account_id: account.id,
        currency: spec.currency,
        type: spec.type,
        status: 'active',
        network: spec.currency === 'NGN' ? 'nem_verve' : 'nem_visa',
        last4: pan.slice(-4),
        expiry_month: 9,
        expiry_year: 2029,
        name_on_card: record.view.customer.name.toUpperCase(),
        nickname: null,
        design: 'volt',
        controls: {
          spend_limit: null,
          online_enabled: true,
          international_enabled: true,
          merchant_lock: null,
          ...spec.controls,
        },
        frozen_by_panic: false,
        physical: false,
        created_at: '2026-10-20T09:00:00Z',
      },
    };
  });
}
