import type { Schema } from '@nem/contracts';
import { negate, zero } from '@nem/shared';

import { problem } from '../../errors';
import type { BillsRepo } from '../../repositories';
import { api, fromApi, naira, newestFirst, notFound, paginate, positive } from '../convert';
import { detectNetwork, externalAccountName } from '../directory';
import { assertWithinDailyLimit } from '../ledger';
import type { MockBank } from '../runtime';

// Sandbox billers (VTpass-style): airtime, data, prepaid electricity and cable TV.

const NETWORKS: { id: Schema<'MobileNetwork'>; name: string }[] = [
  { id: 'mtn', name: 'MTN' },
  { id: 'airtel', name: 'Airtel' },
  { id: 'glo', name: 'Glo' },
  { id: 'nine_mobile', name: '9mobile' },
];

export const BILLERS: Schema<'Biller'>[] = [
  ...NETWORKS.map((n) => ({
    id: `${n.id}-airtime`,
    category: 'airtime' as const,
    name: `${n.name} Airtime`,
    network: n.id,
    logo_url: null,
    requires_validation: false,
    has_products: false,
    min_amount: api(naira(50)),
  })),
  ...NETWORKS.map((n) => ({
    id: `${n.id}-data`,
    category: 'data' as const,
    name: `${n.name} Data`,
    network: n.id,
    logo_url: null,
    requires_validation: false,
    has_products: true,
    min_amount: null,
  })),
  ...[
    ['ikeja-electric-prepaid', 'Ikeja Electric (prepaid)'],
    ['eko-electric-prepaid', 'Eko Electric (prepaid)'],
    ['abuja-electric-prepaid', 'Abuja Electric (prepaid)'],
  ].map(([id, name]) => ({
    id: id!,
    category: 'electricity' as const,
    name: name!,
    network: null,
    logo_url: null,
    requires_validation: true,
    has_products: false,
    min_amount: api(naira(1_000)),
  })),
  ...[
    ['dstv', 'DStv'],
    ['gotv', 'GOtv'],
    ['startimes', 'StarTimes'],
  ].map(([id, name]) => ({
    id: id!,
    category: 'cable_tv' as const,
    name: name!,
    network: null,
    logo_url: null,
    requires_validation: true,
    has_products: true,
    min_amount: null,
  })),
];

const product = (id: string, name: string, major: number, validity: number | null) => ({
  id,
  name,
  amount: api(naira(major)),
  validity_days: validity,
});

const DATA_PLANS = [
  product('1gb-1d', '1GB, 1 day', 500, 1),
  product('2gb-7d', '2GB, 7 days', 1_000, 7),
  product('10gb-30d', '10GB, 30 days', 5_000, 30),
  product('25gb-30d', '25GB, 30 days', 10_000, 30),
];

const PRODUCTS: Record<string, Schema<'BillerProduct'>[]> = {
  dstv: [
    product('padi', 'DStv Padi', 4_400, 30),
    product('compact', 'DStv Compact', 19_000, 30),
    product('premium', 'DStv Premium', 44_500, 30),
  ],
  gotv: [product('jolli', 'GOtv Jolli', 5_800, 30), product('max', 'GOtv Max', 8_500, 30)],
  startimes: [product('basic', 'Nova Basic', 2_600, 30), product('classic', 'Classic', 6_000, 30)],
};

const productsFor = (billerId: string) =>
  billerId.endsWith('-data') ? DATA_PLANS : (PRODUCTS[billerId] ?? []);

const CATEGORY: Record<Schema<'BillCategory'>, Schema<'Category'>> = {
  airtime: 'airtime_data',
  data: 'airtime_data',
  electricity: 'bills_utilities',
  cable_tv: 'subscriptions',
};

/** ₦ per kWh for the demo token's "units" line. */
const TARIFF_PER_KWH = 225;

function biller(id: string): Schema<'Biller'> {
  const found = BILLERS.find((b) => b.id === id);
  if (!found) throw notFound('Biller');
  return found;
}

function validateCustomer(b: Schema<'Biller'>, customerId: string): Schema<'BillValidation'> {
  const digits = customerId.replace(/\s/g, '');
  const ok = b.category === 'electricity' ? /^\d{11}$/.test(digits) : /^\d{10}$/.test(digits);
  // The sandbox has no meter or smartcard ending in 0000, so the error path can be shown.
  if (!ok || digits.endsWith('0000')) {
    throw problem(
      404,
      'customer_not_found',
      `We could not find that ${b.category === 'electricity' ? 'meter' : 'smartcard'} number`,
    );
  }
  const name = externalAccountName(digits.slice(-10))!.toUpperCase();
  return {
    biller_id: b.id,
    customer_id: digits,
    customer_name: name,
    address: b.category === 'electricity' ? '12 Admiralty Way, Lekki Phase 1' : null,
    current_plan: b.category === 'cable_tv' ? (productsFor(b.id)[1]?.name ?? null) : null,
  };
}

export function payBill(bank: MockBank, body: Schema<'PayBillRequest'>): Schema<'BillPayment'> {
  bank.assertCanSend();
  const b = biller(body.biller_id);
  const source = bank.ownAccount(body.source_account_id);
  if (source.currency !== 'NGN')
    throw problem(422, 'validation_failed', 'Pay bills from your naira account');
  const amount = positive(body.amount, 'NGN');
  const chosen = body.product_id
    ? productsFor(b.id).find((p) => p.id === body.product_id)
    : undefined;
  if (b.has_products && !chosen) throw problem(422, 'validation_failed', 'Pick a plan');
  if (chosen && chosen.amount.amount_minor !== body.amount.amount_minor) {
    throw problem(422, 'validation_failed', 'The amount does not match the plan');
  }
  if (b.min_amount && amount.amount < fromApi(b.min_amount).amount) {
    throw problem(422, 'validation_failed', 'The amount is below the minimum');
  }
  const customer = b.requires_validation ? validateCustomer(b, body.customer_id) : null;
  if (!b.requires_validation && b.category !== 'electricity') {
    if (!/^(\+?234|0)\d{10}$/.test(body.customer_id.replace(/\s/g, ''))) {
      throw problem(422, 'validation_failed', 'Enter a Nigerian phone number');
    }
  }
  assertWithinDailyLimit(bank.ledger, source.id, amount, bank.limits(), bank.nowIso());

  const id = bank.id();
  const reference = bank.reference('BIL');
  const entry = bank.ledger.post({
    kind: 'bill_payment',
    reference,
    idempotencyKey: `bill:${id}`,
    postings: [
      { accountId: source.id, amount: negate(amount) },
      { accountId: bank.ledger.systemAccount('partner_settlement', 'NGN').id, amount },
    ],
    limitUsage: { accountId: source.id, amount },
    metadata: {
      txns: [
        {
          id: bank.id(),
          accountId: source.id,
          direction: 'debit',
          type: 'bill_payment',
          category: CATEGORY[b.category],
          narration: chosen ? `${b.name} ${chosen.name}` : b.name,
          counterparty: { name: b.name },
        },
      ],
    },
  });
  const isPower = b.category === 'electricity';
  const token = isPower
    ? Array.from({ length: 5 }, () => String(Math.floor(1000 + Math.random() * 9000))).join('-')
    : null;
  const payment: Schema<'BillPayment'> = {
    id,
    reference,
    biller_id: b.id,
    biller_name: b.name,
    category: b.category,
    product_name: chosen?.name ?? null,
    customer_id: customer?.customer_id ?? body.customer_id,
    amount: api(amount),
    fee: api(zero('NGN')),
    status: 'completed',
    token,
    units: isPower ? `${(Number(amount.amount / 100n) / TARIFF_PER_KWH).toFixed(1)} kWh` : null,
    transaction_id: (entry.metadata.txns as { id: string }[])[0]!.id,
    created_at: entry.createdAt,
  };
  bank.world.billPayments.push(payment);
  if (
    body.save_as &&
    !bank.world.savedBillers.some(
      (s) => s.biller_id === b.id && s.customer_id === payment.customer_id,
    )
  ) {
    bank.world.savedBillers.push({
      id: bank.id(),
      biller_id: b.id,
      biller_name: b.name,
      category: b.category,
      customer_id: payment.customer_id,
      customer_name: customer?.customer_name ?? null,
      nickname: body.save_as,
      created_at: bank.nowIso(),
    });
  }
  return payment;
}

export function processBillSchedules(bank: MockBank): boolean {
  const now = bank.nowIso();
  const due = bank.world.billSchedules.filter(
    (s) => s.status === 'active' && s.next_run_at && s.next_run_at <= now,
  );
  for (const schedule of due) {
    try {
      payBill(bank, schedule.payment);
    } catch (error) {
      bank.notify({
        category: 'transactions',
        title: `${schedule.biller_name} payment skipped`,
        body: error instanceof Error ? error.message : 'The scheduled payment could not be made.',
        deep_link: 'nembank://bills',
      });
    }
    const next = new Date(schedule.next_run_at!);
    if (schedule.frequency === 'once') {
      schedule.status = 'completed';
      schedule.next_run_at = null;
      continue;
    }
    if (schedule.frequency === 'monthly') next.setUTCMonth(next.getUTCMonth() + 1);
    else next.setUTCDate(next.getUTCDate() + (schedule.frequency === 'weekly' ? 7 : 1));
    schedule.next_run_at = next.toISOString();
  }
  return due.length > 0;
}

export function billsRepo(bank: MockBank): BillsRepo {
  const scheduleView = ({ payment: _payment, ...s }: (typeof bank.world.billSchedules)[number]) =>
    s;
  return {
    async listBillers({ query } = {}) {
      return { data: BILLERS.filter((b) => !query?.category || b.category === query.category) };
    },
    async listProducts({ path }) {
      return { data: productsFor(biller(path.biller_id).id) };
    },
    async detectNetwork({ body }) {
      return { phone: body.phone, network: detectNetwork(body.phone) };
    },
    async validateCustomer({ body }) {
      return validateCustomer(biller(body.biller_id), body.customer_id);
    },
    async listPayments({ query } = {}) {
      return paginate(newestFirst(bank.world.billPayments), query);
    },
    async pay({ body, idempotencyKey }) {
      return bank.idempotent(
        idempotencyKey,
        body,
        (id) => bank.world.billPayments.find((p) => p.id === id),
        () => payBill(bank, body),
      );
    },
    async getPayment({ path }) {
      const payment = bank.world.billPayments.find((p) => p.id === path.payment_id);
      if (!payment) throw notFound('Bill payment');
      return payment;
    },
    async listSaved() {
      return { data: newestFirst(bank.world.savedBillers) };
    },
    async save({ body }) {
      const b = biller(body.biller_id);
      const customer = b.requires_validation ? validateCustomer(b, body.customer_id) : null;
      const saved: Schema<'SavedBiller'> = {
        id: bank.id(),
        biller_id: b.id,
        biller_name: b.name,
        category: b.category,
        customer_id: customer?.customer_id ?? body.customer_id,
        customer_name: customer?.customer_name ?? null,
        nickname: body.nickname.trim(),
        created_at: bank.nowIso(),
      };
      bank.world.savedBillers.push(saved);
      return saved;
    },
    async removeSaved({ path }) {
      if (!bank.world.savedBillers.some((s) => s.id === path.saved_biller_id))
        throw notFound('Saved biller');
      bank.world.savedBillers = bank.world.savedBillers.filter(
        (s) => s.id !== path.saved_biller_id,
      );
    },
    async listSchedules() {
      return { data: newestFirst(bank.world.billSchedules).map(scheduleView) };
    },
    async createSchedule({ body, idempotencyKey }) {
      const record = bank.idempotent(
        idempotencyKey,
        body,
        (id) => bank.world.billSchedules.find((s) => s.id === id),
        () => {
          const b = biller(body.payment.biller_id);
          bank.ownAccount(body.payment.source_account_id);
          positive(body.payment.amount, 'NGN');
          if (b.requires_validation) validateCustomer(b, body.payment.customer_id);
          const schedule = {
            id: bank.id(),
            biller_name: b.name,
            customer_id: body.payment.customer_id,
            amount: body.payment.amount,
            frequency: body.frequency,
            status: 'active' as const,
            next_run_at: body.start_at,
            created_at: bank.nowIso(),
            payment: body.payment,
          };
          bank.world.billSchedules.push(schedule);
          return schedule;
        },
      );
      return scheduleView(record);
    },
    async cancelSchedule({ path }) {
      const schedule = bank.world.billSchedules.find((s) => s.id === path.schedule_id);
      if (!schedule) throw notFound('Bill schedule');
      schedule.status = 'cancelled';
      schedule.next_run_at = null;
    },
  };
}
