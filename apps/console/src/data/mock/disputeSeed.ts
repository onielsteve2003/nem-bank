import type { CurrencyCode, Schema } from '@nem/contracts';

import { customerId, type CustomerRecord } from './customerSeed';

// Disputes customers raised from the app (DSP-*). Each one is a common Nigerian
// complaint: a duplicate card charge, a transfer that failed but debited, an
// electricity token that never came, a POS charge the customer never made.

export type AdminDispute = Schema<'AdminDispute'>;
type Dispute = Schema<'Dispute'>;
type Transaction = Schema<'TransactionDetail'>;

export const disputeId = (n: number) =>
  `01900000-0000-7000-8000-0000000d${String(n).padStart(4, '0')}`;
const disputeTxId = (n: number) => `01900000-0000-7000-8000-0000002d${String(n).padStart(4, '0')}`;
const journalId = (n: number) => `01900000-0000-7000-8000-0000003d${String(n).padStart(4, '0')}`;
const evidenceId = (n: number, i: number) =>
  `01900000-0000-7000-8000-0000004d${n}${i}`.padEnd(36, '0');

/** Refunds above this go to a second approver (maker-checker, ADM-10). */
export const REFUND_CHECKER_THRESHOLD: Readonly<Partial<Record<CurrencyCode, bigint>>> = {
  NGN: 100_000_00n,
  USD: 100_00n,
};

const AISHA = { id: '01900000-0000-7000-8000-00000000a002', name: 'Aisha Bello' };

const money = (amount: bigint, currency: CurrencyCode = 'NGN') => ({
  amount_minor: amount.toString(),
  currency,
});

function sampleReceipt(title: string, line: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 560" width="420" height="560"><rect width="420" height="560" rx="14" fill="#f3f4f6"/><g font-family="sans-serif" fill="#4a5160"><text x="30" y="56" font-size="22" font-weight="700">${title}</text><text x="30" y="100" font-size="16">${line}</text><rect x="30" y="130" width="360" height="12" fill="#d5d9df"/><rect x="30" y="160" width="300" height="12" fill="#e1e4e8"/><rect x="30" y="190" width="330" height="12" fill="#e1e4e8"/></g><text x="210" y="520" text-anchor="middle" font-family="sans-serif" font-size="20" font-weight="700" fill="#b4232a" opacity="0.7">SAMPLE · NOT A REAL RECEIPT</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

interface Spec {
  customer: number;
  reason: Dispute['reason'];
  description: string;
  tx: [
    type: Transaction['type'],
    amount: bigint,
    narration: string,
    category: Transaction['category'],
    at: string,
  ];
  currency?: CurrencyCode;
  raised: string;
  status: Dispute['status'];
  evidence?: [file: string, line: string][];
  refund?: bigint;
  resolution?: string;
}

const SPECS: Spec[] = [
  {
    customer: 1,
    reason: 'duplicate_charge',
    description: 'Jumia charged my card twice for the same order. I only got one parcel.',
    tx: ['card_payment', 45_000_00n, 'Jumia Online', 'shopping', '2026-10-27T14:02:00Z'],
    raised: '2026-10-28T09:40:00Z',
    status: 'submitted',
    evidence: [['jumia-order.png', 'Order JM-88213 · ₦45,000 · 1 item']],
  },
  {
    customer: 3,
    reason: 'failed_but_debited',
    description:
      'The app said the transfer to my sister at GTBank failed, but the money left my account. She never got it.',
    tx: [
      'transfer_out',
      120_000_00n,
      'Transfer to Bimpe Adebayo',
      'transfers',
      '2026-10-24T18:20:00Z',
    ],
    raised: '2026-10-25T08:05:00Z',
    status: 'under_review',
  },
  {
    customer: 5,
    reason: 'goods_not_received',
    description: 'Paid for headphones with my USD card. The seller stopped replying after a week.',
    tx: ['card_payment', 89_99n, 'AMZ Marketplace', 'shopping', '2026-10-12T21:10:00Z'],
    currency: 'USD',
    raised: '2026-10-20T11:30:00Z',
    status: 'awaiting_customer',
  },
  {
    customer: 9,
    reason: 'not_received',
    description: 'I bought prepaid electricity but no token came, by SMS or in the app.',
    tx: [
      'bill_payment',
      15_000_00n,
      'Ikeja Electric prepaid',
      'bills_utilities',
      '2026-11-01T07:45:00Z',
    ],
    raised: '2026-11-01T08:10:00Z',
    status: 'submitted',
  },
  {
    customer: 8,
    reason: 'unauthorised',
    description:
      'A POS payment in Abuja I did not make. I was in Lagos all day and my card was with me.',
    tx: ['card_payment', 250_000_00n, 'POS Wuse II Abuja', 'shopping', '2026-11-02T13:15:00Z'],
    raised: '2026-11-02T16:00:00Z',
    status: 'submitted',
    evidence: [['location-history.png', 'Lagos · 2 Nov 2026 · all day']],
  },
  {
    customer: 10,
    reason: 'wrong_amount',
    description: 'My meal was ₦8,500 but the POS charged ₦18,500.',
    tx: ['card_payment', 18_500_00n, 'Chicken Republic Yaba', 'food', '2026-10-18T13:30:00Z'],
    raised: '2026-10-18T15:00:00Z',
    status: 'resolved_refunded',
    evidence: [['receipt.png', 'Chicken Republic · Total ₦8,500']],
    refund: 10_000_00n,
    resolution: 'The receipt shows ₦8,500. We refunded the ₦10,000 difference.',
  },
  {
    customer: 4,
    reason: 'other',
    description: 'I want my money back for a gym subscription I forgot to cancel.',
    tx: ['card_payment', 12_000_00n, 'FitHub Monthly', 'subscriptions', '2026-10-05T06:00:00Z'],
    raised: '2026-10-09T10:00:00Z',
    status: 'resolved_declined',
    resolution:
      'You agreed to this subscription and it was charged correctly. Cancel it from Cards → Subscriptions.',
  },
];

const CLOSED: readonly Dispute['status'][] = [
  'resolved_refunded',
  'resolved_declined',
  'withdrawn',
];
export const isOpenDispute = (status: Dispute['status']) => !CLOSED.includes(status);

function build(spec: Spec, n: number, record: CustomerRecord): AdminDispute {
  const [type, amount, narration, category, at] = spec.tx;
  const currency = spec.currency ?? 'NGN';
  const account =
    record.view.accounts.find((a) => a.currency === currency) ?? record.view.accounts[0]!;
  const id = disputeId(n);
  const resolved = !isOpenDispute(spec.status);
  const resolvedAt = resolved
    ? new Date(Date.parse(spec.raised) + 2 * 86_400_000).toISOString()
    : null;

  const timeline: Dispute['timeline'] = [
    { status: 'submitted', label: 'Dispute raised in the app', at: spec.raised, detail: null },
  ];
  if (spec.status !== 'submitted') {
    timeline.push({
      status: 'under_review',
      label: 'A reviewer picked it up',
      at: new Date(Date.parse(spec.raised) + 3_600_000).toISOString(),
      detail: null,
    });
  }
  if (spec.status === 'awaiting_customer') {
    timeline.push({
      status: 'awaiting_customer',
      label: 'We asked the customer for more',
      at: new Date(Date.parse(spec.raised) + 86_400_000).toISOString(),
      detail: 'Please send the seller’s listing and your messages with them.',
    });
  }
  if (resolvedAt) {
    timeline.push({
      status: spec.status,
      label: spec.status === 'resolved_refunded' ? 'Refunded' : 'Declined',
      at: resolvedAt,
      detail: spec.resolution ?? null,
    });
  }

  return {
    dispute: {
      id,
      case_number: `DSP-2026${String(1000 + n).padStart(4, '0')}`,
      transaction_id: disputeTxId(n),
      reason: spec.reason,
      description: spec.description,
      status: spec.status,
      timeline,
      evidence: (spec.evidence ?? []).map(([file, line], i) => ({
        id: evidenceId(n, i),
        file_name: file,
        content_type: 'image/png',
        size_bytes: 184_000 + i * 21_000,
        url: sampleReceipt(narration, line),
        uploaded_at: spec.raised,
      })),
      refund: spec.refund === undefined ? null : money(spec.refund, currency),
      resolution_note: spec.resolution ?? null,
      created_at: spec.raised,
      resolved_at: resolvedAt,
    },
    customer: record.view.customer,
    transaction: {
      id: disputeTxId(n),
      account_id: account.id,
      type,
      direction: 'debit',
      status: 'completed',
      amount: money(amount, currency),
      fee: null,
      balance_after: null,
      narration,
      reference: `NEM2026D${String(n).padStart(4, '0')}`,
      category,
      category_source: 'rules',
      counterparty: { name: narration },
      transfer_id: null,
      card_id: null,
      created_at: at,
      timeline: [
        { status: 'completed', label: 'Paid', at, detail: null },
        { status: 'disputed', label: 'Disputed by the customer', at: spec.raised, detail: null },
      ],
      fees: [],
      journal_entry_id: journalId(n),
      can_dispute: false,
      can_repeat: false,
      dispute_id: id,
    },
    assignee: spec.status === 'submitted' ? null : AISHA,
  };
}

/** Builds the disputes and recounts each customer's open ones on their 360. */
export function seedDisputes(customers: Map<string, CustomerRecord>): Map<string, AdminDispute> {
  for (const record of customers.values()) record.view.open_cases.disputes = 0;
  const disputes = SPECS.map((spec, i) => {
    const record = customers.get(customerId(spec.customer))!;
    const d = build(spec, i + 1, record);
    if (isOpenDispute(d.dispute.status)) record.view.open_cases.disputes += 1;
    return d;
  });
  return new Map(disputes.map((d) => [d.dispute.id, d]));
}
