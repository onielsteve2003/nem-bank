import type { Schema } from '@nem/contracts';

import { customerId, maskAccountNumber, type CustomerRecord } from './customerSeed';

// Held transfers the risk engine sent to staff. Each pattern is one Nigerian fraud
// typology the rules and model look for: account takeover, mule accounts, scam
// pressure, a sudden spike. Scores and reasons match what the Go engine will emit.

export type FraudCase = Schema<'FraudCase'>;
type Reason = Schema<'RiskReason'>;

export const fraudCaseId = (n: number) =>
  `01900000-0000-7000-8000-0000000f${String(n).padStart(4, '0')}`;
const transferId = (n: number) => `01900000-0000-7000-8000-0000001f${String(n).padStart(4, '0')}`;

export const MODEL_VERSION = 'fraud-gbdt-2026.10.2';

const REASONS = {
  new_device: {
    code: 'new_device',
    severity: 'high',
    message: 'Sent from a device bound less than a day ago',
  },
  new_beneficiary: {
    code: 'new_beneficiary',
    severity: 'medium',
    message: 'First transfer to this recipient',
  },
  amount_spike: {
    code: 'amount_spike',
    severity: 'high',
    message: 'Over 10× the customer’s average transfer',
  },
  velocity: {
    code: 'velocity',
    severity: 'medium',
    message: 'Many transfers in the last hour',
  },
  mule_inflow: {
    code: 'mule_inflow',
    severity: 'high',
    message: 'Money in from several strangers, then straight out',
  },
  scam_keyword: {
    code: 'scam_keyword',
    severity: 'medium',
    message: 'Narration matches a known scam script (“urgent”, “customs fee”)',
  },
  night_time: {
    code: 'night_time',
    severity: 'low',
    message: 'Sent between 00:00 and 05:00, unusual for this customer',
  },
  young_account: {
    code: 'young_account',
    severity: 'medium',
    message: 'Account opened in the last 7 days',
  },
} as const satisfies Record<string, Reason>;

interface Spec {
  customer: number;
  amount: bigint;
  recipient: [name: string, bank: string, bankCode: string, account: string];
  narration: string;
  score: number;
  reasons: (keyof typeof REASONS)[];
  heldAt: string;
  signals: { device: number; beneficiary: number | null; last24h: number; average: bigint };
  status?: FraudCase['status'];
  label?: Schema<'FraudLabel'>;
  note?: string;
}

const SPECS: Spec[] = [
  {
    customer: 2,
    amount: 1_850_000_00n,
    recipient: ['Chukwudi Enterprises', 'Opay', '999992', '8123456789'],
    narration: 'urgent payment',
    score: 0.93,
    reasons: ['new_device', 'new_beneficiary', 'amount_spike', 'scam_keyword'],
    heldAt: '2026-11-03T08:41:00Z',
    signals: { device: 6, beneficiary: 0, last24h: 4, average: 38_000_00n },
  },
  {
    customer: 10,
    amount: 480_000_00n,
    recipient: ['Mary Johnson', 'Moniepoint', '50515', '6034412290'],
    narration: 'customs fee for parcel',
    score: 0.81,
    reasons: ['new_beneficiary', 'scam_keyword', 'young_account'],
    heldAt: '2026-11-03T07:12:00Z',
    signals: { device: 170, beneficiary: 0, last24h: 1, average: 12_000_00n },
  },
  {
    customer: 12,
    amount: 295_000_00n,
    recipient: ['Abubakar Sani', 'Kuda', '50211', '2011873345'],
    narration: 'transfer',
    score: 0.77,
    reasons: ['mule_inflow', 'young_account', 'velocity'],
    heldAt: '2026-11-03T03:20:00Z',
    signals: { device: 90, beneficiary: 2, last24h: 11, average: 9_500_00n },
  },
  {
    customer: 6,
    amount: 60_000_00n,
    recipient: ['Seyi Bakare', 'GTBank', '058', '0123987654'],
    narration: 'for mum',
    score: 0.58,
    reasons: ['night_time', 'young_account'],
    heldAt: '2026-11-03T02:05:00Z',
    signals: { device: 55, beneficiary: 400, last24h: 1, average: 15_000_00n },
  },
  {
    customer: 11,
    amount: 2_400_000_00n,
    recipient: ['Prime Autos Ltd', 'Access Bank', '044', '0690011223'],
    narration: 'Toyota Corolla balance',
    score: 0.71,
    reasons: ['amount_spike', 'new_beneficiary'],
    heldAt: '2026-11-02T15:30:00Z',
    signals: { device: 4_100, beneficiary: 0, last24h: 1, average: 85_000_00n },
    status: 'in_review',
  },
  {
    customer: 9,
    amount: 350_000_00n,
    recipient: ['Zainab Abdullahi', 'Zenith Bank', '057', '2203344556'],
    narration: 'school fees',
    score: 0.62,
    reasons: ['amount_spike'],
    heldAt: '2026-11-01T10:00:00Z',
    signals: { device: 9_000, beneficiary: 2_000, last24h: 1, average: 30_000_00n },
    status: 'released',
    label: 'legitimate',
    note: 'Called the customer: termly school fees, same recipient as last term.',
  },
  {
    customer: 8,
    amount: 900_000_00n,
    recipient: ['Global Crypto Desk', 'Palmpay', '999991', '9011228877'],
    narration: 'investment urgent',
    score: 0.95,
    reasons: ['new_device', 'new_beneficiary', 'scam_keyword', 'amount_spike'],
    heldAt: '2026-10-31T21:45:00Z',
    signals: { device: 2, beneficiary: 0, last24h: 3, average: 40_000_00n },
    status: 'rejected',
    label: 'fraud',
    note: 'Customer did not recognise the device. Session revoked, password reset sent.',
  },
];

const AISHA = { id: '01900000-0000-7000-8000-00000000a002', name: 'Aisha Bello' };
const HOUR = 3_600_000;
const money = (amount: bigint) => ({ amount_minor: amount.toString(), currency: 'NGN' as const });

function build(spec: Spec, n: number, record: CustomerRecord): FraudCase {
  const status = spec.status ?? 'open';
  const closed = status === 'released' || status === 'rejected';
  const closedAt = closed ? new Date(Date.parse(spec.heldAt) + 2 * HOUR).toISOString() : null;
  const createdAt = new Date(Date.parse(spec.heldAt) - 60_000).toISOString();
  const [name, bank, bankCode, account] = spec.recipient;
  // NIP fee for amounts over ₦50,000: ₦25 + 7.5% VAT, rounded half-up to ₦26.88.
  const fee = 26_88n;
  const risk: Schema<'RiskAssessment'> = {
    decision: 'hold',
    score: spec.score,
    reasons: spec.reasons.map((r) => REASONS[r]),
    model_version: MODEL_VERSION,
  };
  const timeline: Schema<'TimelineEvent'>[] = [
    { status: 'created', label: 'Transfer started', at: createdAt, detail: null },
    {
      status: 'held_for_review',
      label: 'Held for a safety check',
      at: spec.heldAt,
      detail: `Risk score ${Math.round(spec.score * 100)} / 100`,
    },
  ];
  if (closedAt) {
    timeline.push(
      status === 'released'
        ? {
            status: 'completed',
            label: 'Released after review and sent',
            at: closedAt,
            detail: null,
          }
        : {
            status: 'rejected',
            label: 'Stopped after review; money returned',
            at: closedAt,
            detail: null,
          },
    );
  }
  return {
    id: fraudCaseId(n),
    status,
    transfer: {
      id: transferId(n),
      reference: `NEM20261103H${String(n).padStart(4, '0')}`,
      status:
        status === 'released'
          ? 'completed'
          : status === 'rejected'
            ? 'rejected'
            : 'held_for_review',
      rail: 'interbank',
      source_account_id: record.view.accounts[0]!.id,
      recipient: {
        name,
        nemtag: null,
        bank_code: bankCode,
        bank_name: bank,
        account_number_masked: maskAccountNumber(account),
      },
      amount: money(spec.amount),
      fee: money(fee),
      total_debit: money(spec.amount + fee),
      narration: spec.narration,
      risk,
      step_up_id: null,
      release_at: null,
      timeline,
      reversal: null,
      transaction_id: null,
      created_at: createdAt,
      updated_at: closedAt ?? spec.heldAt,
    },
    risk,
    customer: record.view.customer,
    signals: {
      device_age_hours: spec.signals.device,
      beneficiary_age_hours: spec.signals.beneficiary,
      transfers_last_24h: spec.signals.last24h,
      average_transfer: money(spec.signals.average),
    },
    assignee: status === 'open' ? null : AISHA,
    label: spec.label ?? null,
    note: spec.note ?? null,
    created_at: spec.heldAt,
    closed_at: closedAt,
  };
}

/** Builds the cases and counts each customer's open ones on their 360. */
export function seedFraud(customers: Map<string, CustomerRecord>): Map<string, FraudCase> {
  const cases = SPECS.map((spec, i) => {
    const record = customers.get(customerId(spec.customer))!;
    const fraudCase = build(spec, i + 1, record);
    if (fraudCase.status === 'open' || fraudCase.status === 'in_review') {
      record.view.open_cases.fraud += 1;
    }
    return fraudCase;
  });
  return new Map(cases.map((c) => [c.id, c]));
}
