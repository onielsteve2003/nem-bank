import type { CurrencyCode, Schema } from '@nem/contracts';

type KycTier = Schema<'KycTier'>;

// Twelve fictional customers with enough history to make the 360 view, the KYC queue
// and the fraud queue feel like a real back office. Names and numbers are invented.

export type Customer360 = Schema<'Customer360'>;
type Transaction = Schema<'Transaction'>;

/** A customer as the bank stores it: the full view plus what staff may search by. */
export interface CustomerRecord {
  view: Customer360;
  /** Unmasked, for search only; never returned to the console. */
  email: string;
  phone: string;
}

const NEM_BANK_CODE = '090999';

export const customerId = (n: number) =>
  `01900000-0000-7000-8000-0000000c${String(n).padStart(4, '0')}`;
const accountId = (n: number, i: number) =>
  `01900000-0000-7000-8000-0000000a${n}${i}`.padEnd(36, '0');
const deviceId = (n: number, i: number) =>
  `01900000-0000-7000-8000-0000000d${n}${i}`.padEnd(36, '0');
const txId = (n: number, i: number) => `01900000-0000-7000-8000-0000000e${n}${i}`.padEnd(36, '0');

const money = (amount: bigint, currency: CurrencyCode) => ({
  amount_minor: amount.toString(),
  currency,
});

export const maskEmail = (email: string) => {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
};
export const maskPhone = (phone: string) => `${phone.slice(0, 8)} *** ${phone.slice(-4)}`;
export const maskAccountNumber = (nuban: string) => `******${nuban.slice(-4)}`;

interface Spec {
  name: string;
  email: string;
  phone: string;
  nemtag: string | null;
  tier: KycTier;
  dob: string;
  joined: string;
  ngnBalance: bigint;
  usdBalance?: bigint;
  frozen?: boolean;
  flags?: Customer360['flags'];
  devices?: [name: string, platform: 'ios' | 'android' | 'web', city: string][];
}

const SPECS: Spec[] = [
  {
    name: 'Adaeze Okonkwo',
    email: 'adaeze.okonkwo@gmail.com',
    phone: '+2348031234821',
    nemtag: 'adaeze',
    tier: 3,
    dob: '1991-04-12',
    joined: '2025-02-14T09:20:00Z',
    ngnBalance: 1_284_500_00n,
    usdBalance: 2_150_00n,
    flags: ['demo'],
    devices: [
      ['iPhone 15', 'ios', 'Lagos, NG'],
      ['Chrome on Mac', 'web', 'Lagos, NG'],
    ],
  },
  {
    name: 'Emeka Nwosu',
    email: 'emeka.nwosu@yahoo.com',
    phone: '+2348064419035',
    nemtag: 'emekan',
    tier: 2,
    dob: '1988-11-03',
    joined: '2025-06-01T14:05:00Z',
    ngnBalance: 412_300_00n,
    flags: ['fraud_watch', 'new_device_cool_off'],
    devices: [['Samsung Galaxy A54', 'android', 'Abuja, NG']],
  },
  {
    name: 'Funmilayo Adebayo',
    email: 'funmi.adebayo@outlook.com',
    phone: '+2348129987710',
    nemtag: 'funmi',
    tier: 2,
    dob: '1995-07-22',
    joined: '2025-09-18T11:40:00Z',
    ngnBalance: 96_750_00n,
  },
  {
    name: 'Ibrahim Musa',
    email: 'ibrahim.musa@gmail.com',
    phone: '+2347035512268',
    nemtag: 'imusa',
    tier: 1,
    dob: '1999-01-30',
    joined: '2026-10-29T08:15:00Z',
    ngnBalance: 18_200_00n,
  },
  {
    name: 'Ngozi Eze',
    email: 'ngozi.eze@gmail.com',
    phone: '+2348092270154',
    nemtag: 'ngozie',
    tier: 3,
    dob: '1984-09-09',
    joined: '2024-12-02T16:30:00Z',
    ngnBalance: 3_905_000_00n,
    usdBalance: 12_400_00n,
    frozen: true,
    flags: ['frozen', 'duress_triggered'],
  },
  {
    name: 'Oluwaseun Bakare',
    email: 'seun.bakare@protonmail.com',
    phone: '+2348157743310',
    nemtag: 'seunb',
    tier: 1,
    dob: '2001-05-17',
    joined: '2026-10-31T19:02:00Z',
    ngnBalance: 4_500_00n,
  },
  {
    name: 'Chiamaka Obi',
    email: 'chiamaka.obi@gmail.com',
    phone: '+2348028860442',
    nemtag: null,
    tier: 1,
    dob: '1997-12-01',
    joined: '2026-11-01T07:48:00Z',
    ngnBalance: 0n,
  },
  {
    name: 'Tolulope Ajayi',
    email: 'tolu.ajayi@gmail.com',
    phone: '+2349011187726',
    nemtag: 'tolu',
    tier: 2,
    dob: '1993-03-08',
    joined: '2025-11-11T10:10:00Z',
    ngnBalance: 1_020_000_00n,
    flags: ['limit_override'],
  },
  {
    name: 'Yusuf Abdullahi',
    email: 'yusuf.abdullahi@gmail.com',
    phone: '+2348183320947',
    nemtag: 'yusufa',
    tier: 2,
    dob: '1986-06-25',
    joined: '2025-04-04T13:55:00Z',
    ngnBalance: 236_400_00n,
    usdBalance: 640_00n,
  },
  {
    name: 'Blessing Udoh',
    email: 'blessing.udoh@yahoo.com',
    phone: '+2348145509981',
    nemtag: 'blessu',
    tier: 1,
    dob: '2000-10-14',
    joined: '2026-10-27T15:20:00Z',
    ngnBalance: 52_000_00n,
  },
  {
    name: 'Kelechi Okafor',
    email: 'kelechi.okafor@gmail.com',
    phone: '+2348067781123',
    nemtag: 'kcokafor',
    tier: 2,
    dob: '1990-08-19',
    joined: '2025-07-23T09:00:00Z',
    ngnBalance: 774_900_00n,
    flags: ['fraud_watch'],
  },
  {
    name: 'Halima Garba',
    email: 'halima.garba@gmail.com',
    phone: '+2348036654490',
    nemtag: 'halima',
    tier: 1,
    dob: '1998-02-05',
    joined: '2026-10-30T12:12:00Z',
    ngnBalance: 9_800_00n,
  },
];

// A small rota of everyday activity; each customer gets a different slice of it.
const ACTIVITY: [
  Transaction['type'],
  Transaction['direction'],
  bigint,
  string,
  Transaction['category'],
][] = [
  ['transfer_in', 'credit', 250_000_00n, 'Salary October', 'salary_income'],
  ['card_payment', 'debit', 8_450_00n, 'Shoprite Lekki', 'groceries'],
  ['bill_payment', 'debit', 15_000_00n, 'Ikeja Electric prepaid', 'bills_utilities'],
  ['transfer_out', 'debit', 40_000_00n, 'Rent share', 'rent_housing'],
  ['card_payment', 'debit', 4_200_00n, 'Bolt ride', 'transport'],
  ['transfer_in', 'credit', 12_500_00n, 'Refund from Tunde', 'transfers'],
  ['bill_payment', 'debit', 2_000_00n, 'MTN airtime', 'airtime_data'],
  ['card_payment', 'debit', 6_900_00n, 'Netflix', 'subscriptions'],
];

const DAY = 86_400_000;
const AS_OF = Date.parse('2026-11-03T09:00:00Z');

function transactions(n: number, account: string, count: number): Transaction[] {
  return Array.from({ length: count }, (_, i) => {
    const [type, direction, amount, narration, category] = ACTIVITY[(n + i) % ACTIVITY.length]!;
    return {
      id: txId(n, i),
      account_id: account,
      type,
      direction,
      status: 'completed',
      amount: money(amount, 'NGN'),
      fee: null,
      balance_after: null,
      narration,
      reference: `NEM2026${String(1100 - i).padStart(4, '0')}C${n}${i}`,
      category,
      category_source: 'rules',
      counterparty: { name: narration },
      transfer_id: null,
      card_id: null,
      created_at: new Date(AS_OF - (i * 1.7 + n * 0.3) * DAY).toISOString(),
    };
  });
}

function build(spec: Spec, n: number): CustomerRecord {
  const nuban = `90${String(n).padStart(2, '0')}${spec.phone.slice(-6)}`;
  const status = spec.frozen ? 'frozen' : 'active';
  const ngn = accountId(n, 0);
  const accounts: Customer360['accounts'] = [
    {
      id: ngn,
      currency: 'NGN',
      kind: 'ngn_current',
      status,
      nickname: null,
      ledger_balance: money(spec.ngnBalance, 'NGN'),
      available_balance: money(spec.ngnBalance, 'NGN'),
      max_balance: spec.tier === 1 ? money(300_000_00n, 'NGN') : null,
      receiving_details: {
        scheme: 'nuban',
        bank_name: 'Nem Bank (demo)',
        bank_code: NEM_BANK_CODE,
        account_number: nuban,
        account_name: spec.name,
        demo: true,
      },
      opened_at: spec.joined,
    },
  ];
  if (spec.usdBalance !== undefined) {
    accounts.push({
      ...accounts[0]!,
      id: accountId(n, 1),
      currency: 'USD',
      kind: 'fx_wallet',
      ledger_balance: money(spec.usdBalance, 'USD'),
      available_balance: money(spec.usdBalance, 'USD'),
      max_balance: null,
      receiving_details: {
        scheme: 'nuban',
        bank_name: 'Nem Bank (demo)',
        bank_code: NEM_BANK_CODE,
        account_number: `91${nuban.slice(2)}`,
        account_name: spec.name,
        demo: true,
      },
    });
  }
  const joinedMs = Date.parse(spec.joined);
  const devices = (spec.devices ?? [['iPhone 13', 'ios', 'Lagos, NG']]).map(
    ([name, platform, city], i): Customer360['devices'][number] => {
      const recent = AS_OF - joinedMs < 3 * DAY || spec.flags?.includes('new_device_cool_off');
      return {
        id: deviceId(n, i),
        name,
        platform,
        current: false,
        trusted: !recent || i > 0,
        hardware_backed: platform !== 'web',
        key_fingerprint: (n * 7919 + i * 104729).toString(16).padStart(16, '0').slice(-16),
        bound_at: spec.joined,
        last_seen_at: new Date(AS_OF - (i + 1) * 3_600_000).toISOString(),
        cool_off_until: recent ? new Date(AS_OF + DAY).toISOString() : null,
        location_hint: city,
      };
    },
  );
  const activity = spec.ngnBalance === 0n ? 0 : 3 + (n % 5);

  return {
    email: spec.email,
    phone: spec.phone,
    view: {
      customer: {
        user_id: customerId(n),
        name: spec.name,
        email_masked: maskEmail(spec.email),
        phone_masked: maskPhone(spec.phone),
        nemtag: spec.nemtag,
        kyc_tier: spec.tier,
        status,
        created_at: spec.joined,
      },
      date_of_birth: spec.dob,
      accounts,
      kyc: {
        tier: spec.tier,
        status: spec.tier > 1 ? 'approved' : 'not_started',
        latest_submission: null,
      },
      devices,
      recent_transactions: transactions(n, ngn, activity),
      notes: spec.frozen
        ? [
            {
              id: `01900000-0000-7000-8000-0000000f${n}00`.padEnd(36, '0'),
              author: { id: '01900000-0000-7000-8000-00000000a002', name: 'Aisha Bello' },
              body: 'Customer used the duress PIN at 21:14. Account frozen while we call the registered number.',
              created_at: '2026-11-02T20:31:00Z',
            },
          ]
        : [],
      flags: spec.flags ?? [],
      panic: {
        active: spec.frozen === true,
        activated_at: spec.frozen ? '2026-11-02T20:14:00Z' : null,
        cards_frozen: spec.frozen ? 2 : 0,
        outgoing_blocked: spec.frozen === true,
      },
      open_cases: { fraud: 0, disputes: n % 4 === 1 ? 1 : 0, support: n % 3 === 0 ? 1 : 0 },
    },
  };
}

export function seedCustomers(): Map<string, CustomerRecord> {
  return new Map(SPECS.map((spec, i) => [customerId(i + 1), build(spec, i + 1)] as const));
}
