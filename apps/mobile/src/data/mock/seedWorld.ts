import type { Schema } from '@nem/contracts';
import { money, negate, type Money } from '@nem/shared';

import type { TransactionMeta } from './bank';
import { addDays, api, isoDate, naira } from './convert';
import { NEM_BANK } from './directory';
import { DEMO_PIN } from './domains/auth';
import { demoFund, type JournalEntry, type Ledger } from './ledger';
import type { CardRecord, Person, World } from './world';

// The persona's world beyond the ledger: people to pay, a card, savings, an ajo
// circle, budgets and an inbox, so every screen has something real to show.

export interface SeedFriend {
  name: string;
  bank_name: string;
  bank_code: string;
  account_number: string;
  family?: boolean;
}

export const SEED_FRIENDS: SeedFriend[] = [
  {
    name: 'Chidi Okonkwo',
    bank_name: 'Access Bank',
    bank_code: '044',
    account_number: '0123456789',
  },
  { name: 'Funmi Ade', bank_name: 'Zenith Bank', bank_code: '057', account_number: '2234567890' },
  {
    name: 'Ibrahim Musa',
    bank_name: 'First Bank of Nigeria',
    bank_code: '011',
    account_number: '3034567891',
  },
  {
    name: 'Mama Adebayo',
    bank_name: 'First Bank of Nigeria',
    bank_code: '011',
    account_number: '3045678912',
    family: true,
  },
];

const NEM_PEOPLE = [
  { firstName: 'Amaka', lastName: 'Obi', nemtag: 'amaka_o' },
  { firstName: 'Emeka', lastName: 'Nwosu', nemtag: 'emeka' },
  { firstName: 'Bisi', lastName: 'Lawal', nemtag: 'bisi_l' },
  { firstName: 'Ngozi', lastName: 'Eze', nemtag: 'mama_ngozi' },
  { firstName: 'Kunle', lastName: 'Adeyemi', nemtag: 'kunle' },
];

export const TOLU_ACCOUNT_NUMBER = '0420269110';

const off = { in_app: true, push: false, email: false };
const all = { in_app: true, push: true, email: true };

interface StartInput {
  ledger: Ledger;
  newId: () => string;
  random: () => number;
  userId: string;
  ngn: string;
  usd: string;
}

export interface WorldDraft extends StartInput {
  world: World;
  cards: CardRecord[];
  recordSettledTransfer(input: {
    id: string;
    entry: JournalEntry;
    to: SeedFriend;
    note: string;
    transactionId: string;
  }): void;
}

const digits = (random: () => number, count: number) =>
  Array.from({ length: count }, () => Math.floor(random() * 10)).join('');

export function startWorld({ ledger, newId, random, userId, ngn, usd }: StartInput): WorldDraft {
  const at = ledger.now().toISOString();
  const people: Person[] = NEM_PEOPLE.map((p, i) => {
    const personId = newId();
    const accountId = ledger.openAccount({
      ownerType: 'customer',
      ownerId: personId,
      kind: 'customer_current',
      currency: 'NGN',
    }).id;
    demoFund(ledger, {
      toAccountId: accountId,
      amount: naira(400_000),
      tier: 3,
      idempotencyKey: newId(),
    });
    return {
      ...p,
      userId: personId,
      accountId,
      accountNumber: `04202${70_000 + i * 1_111}`,
      tier: 3,
    };
  });

  const deviceId = newId();
  const webId = newId();
  const pan = `506099${digits(random, 10)}`;
  const card: CardRecord = {
    id: newId(),
    account_id: ngn,
    currency: 'NGN',
    type: 'standard',
    status: 'active',
    network: 'nem_verve',
    last4: pan.slice(-4),
    expiry_month: 9,
    expiry_year: 2030,
    name_on_card: 'TOLULOPE ADEBAYO',
    nickname: 'Everyday',
    design: 'volt',
    controls: {
      spend_limit: { amount: api(naira(200_000)), period: 'daily' },
      online_enabled: true,
      international_enabled: false,
      merchant_lock: null,
    },
    frozen_by_panic: false,
    physical: false,
    created_at: at,
    pan,
    cvv: digits(random, 3),
  };

  const beneficiaries: Schema<'Beneficiary'>[] = SEED_FRIENDS.map((f) => ({
    id: newId(),
    kind: 'bank',
    name: f.name,
    nickname: f.family ? 'Mummy' : null,
    nemtag: null,
    bank_code: f.bank_code,
    bank_name: f.bank_name,
    account_number: f.account_number,
    favourite: Boolean(f.family),
    cooling_off_until: null,
    last_paid_at: null,
    created_at: at,
  }));
  const amaka = people[0]!;
  beneficiaries.push({
    id: newId(),
    kind: 'nem',
    name: `${amaka.firstName} ${amaka.lastName}`,
    nickname: null,
    nemtag: amaka.nemtag,
    bank_code: NEM_BANK.code,
    bank_name: NEM_BANK.name,
    account_number: amaka.accountNumber,
    favourite: true,
    cooling_off_until: null,
    last_paid_at: null,
    created_at: at,
  });

  const world: World = {
    clockOffsetDays: 0,
    failNextTransfer: false,
    accountMeta: {
      [ngn]: { accountNumber: TOLU_ACCOUNT_NUMBER, nickname: null },
      [usd]: { accountNumber: '8400269110', nickname: 'Freelance USD' },
    },
    people,
    auth: {
      password: 'Demo1234!',
      pin: DEMO_PIN,
      pinFailures: 0,
      pinLockedUntil: null,
      duressPin: null,
      securityQuestion: null,
      biometricsOn: true,
    },
    otps: {},
    stepUps: {},
    stepUpTokens: {},
    devices: [
      {
        id: deviceId,
        name: "Tolu's iPhone",
        platform: 'ios',
        current: true,
        trusted: true,
        hardware_backed: true,
        key_fingerprint: `SHA256:${digits(random, 12)}`,
        bound_at: at,
        last_seen_at: at,
        cool_off_until: null,
        location_hint: 'Lagos, NG',
      },
      {
        id: webId,
        name: 'Chrome on Windows',
        platform: 'web',
        current: false,
        trusted: false,
        hardware_backed: false,
        key_fingerprint: `SHA256:${digits(random, 12)}`,
        bound_at: at,
        last_seen_at: at,
        cool_off_until: null,
        location_hint: 'Lagos, NG',
      },
    ],
    sessions: [],
    currentDeviceId: deviceId,
    pushTokens: {},
    preferences: {
      appearance: 'system',
      language: 'en',
      low_data_mode: false,
      auto_lock_seconds: 60,
      hide_balances: false,
      ai: {
        smart_categories: true,
        forecast: true,
        scam_checker: true,
        assistant: true,
        id_prefill: true,
      },
    },
    notificationPreferences: {
      categories: {
        transactions: all,
        security: all,
        savings: { ...all, email: false },
        ajo: { ...all, email: false },
        credit: { ...all, email: false },
        support: { ...all, email: false },
        product: off,
        marketing: { in_app: false, push: false, email: false },
      },
    },
    alertPreferences: {
      login_alerts: true,
      new_device_alerts: true,
      transaction_alert_threshold: api(naira(0)),
    },
    selfLimits: { daily: null, single: null, pending: null },
    panic: { active: false, activatedAt: null, frozenCardIds: [] },
    categoryOverrides: {},
    idempotency: {},
    statements: [],
    beneficiaries,
    transfers: [],
    scheduled: [],
    moneyRequests: [],
    splitBills: [],
    paymentLinks: [],
    fxQuotes: {},
    fxConversions: [],
    fxAlerts: [],
    cards: [card],
    cardAuthorizations: [],
    billPayments: [],
    savedBillers: [],
    billSchedules: [],
    goals: [],
    roundUps: { enabled: true, round_to: '10000', goal_id: null, sources: ['card'] },
    locks: [],
    ajo: [],
    loanOffers: {},
    loans: [],
    budgets: [],
    kyc: { status: 'approved', documents: [], submissions: [], verifiedIds: ['bvn', 'nin'] },
    disputes: [],
    attachments: [],
    conversations: [],
    messages: [],
    notifications: [],
    dependants: [],
    approvals: [],
    assistant: { conversations: [], messages: [], actions: [] },
    privacyRequests: [],
    sequence: 1_000,
  };

  return {
    ledger,
    newId,
    random,
    userId,
    ngn,
    usd,
    world,
    cards: world.cards,
    recordSettledTransfer({ id, entry, to, note, transactionId }) {
      const amount = entry.limitUsage!.amount;
      const fee = money(String(entry.metadata.fee ?? '0'), amount.currency);
      const beneficiary = beneficiaries.find((b) => b.account_number === to.account_number);
      if (beneficiary) beneficiary.last_paid_at = entry.createdAt;
      world.transfers.push({
        id,
        reference: entry.reference,
        status: 'completed',
        rail: 'interbank',
        source_account_id: ngn,
        recipient: {
          name: to.name,
          nemtag: null,
          bank_code: to.bank_code,
          bank_name: to.bank_name,
          account_number_masked: `******${to.account_number.slice(-4)}`,
        },
        amount: api(amount),
        fee: api(fee),
        total_debit: api(money(amount.amount + fee.amount, amount.currency)),
        narration: note,
        risk: { decision: 'allow', score: 0.04, reasons: [], model_version: 'rules-mock-1' },
        timeline: [
          { status: 'created', label: 'Transfer created', at: entry.createdAt },
          { status: 'processing', label: 'Sent to the recipient bank', at: entry.createdAt },
          { status: 'completed', label: 'Received by the recipient bank', at: entry.createdAt },
        ],
        transaction_id: transactionId,
        created_at: entry.createdAt,
        updated_at: entry.createdAt,
        destination: { kind: 'bank', bankCode: to.bank_code },
        beneficiaryId: beneficiary?.id ?? null,
        holdId: null,
        dueAt: null,
        category: to.family ? 'family' : 'transfers',
        paysRequestId: null,
        willFail: false,
      });
    },
  };
}

interface FinishInput {
  now: Date;
  start: Date;
  reference: () => string;
}

const party = (p: Person): Schema<'PartySummary'> => ({
  user_id: p.userId,
  name: `${p.firstName} ${p.lastName}`,
  nemtag: p.nemtag,
  avatar_url: null,
});

/** Savings, an ajo circle, budgets and an inbox, created at the end of the history. */
export function finishWorld(draft: WorldDraft, { now, start, reference }: FinishInput): World {
  const { world, ledger, newId, userId, ngn } = draft;
  const at = now.toISOString();
  const me: Schema<'PartySummary'> = {
    user_id: userId,
    name: 'Tolulope Adebayo',
    nemtag: 'tolu_a',
    avatar_url: null,
  };
  const save = (to: string, amount: Money, narration: string) =>
    postSaving(ledger, {
      from: ngn,
      to,
      amount,
      reference: reference(),
      idempotencyKey: newId(),
      txn: {
        id: newId(),
        type: 'savings',
        category: 'savings',
        narration,
        counterparty: { name: 'Nem Savings' },
      },
    });

  const goal = (name: string, emoji: string, target: number, saved: number, targetDate: string) => {
    const accountId = ledger.openAccount({
      ownerType: 'customer',
      ownerId: userId,
      kind: 'customer_savings',
      currency: 'NGN',
    }).id;
    save(accountId, naira(saved), `Saved to ${name}`);
    world.goals.push({
      id: newId(),
      accountId,
      name,
      emoji,
      target: api(naira(target)),
      target_date: targetDate,
      auto_save: { amount: api(naira(20_000)), frequency: 'weekly', source_account_id: ngn },
      interest_rate_bps: 1_000,
      interest_earned: api(naira(Math.round(saved * 0.012))),
      status: 'active',
      created_at: addDays(now, -90).toISOString(),
    });
  };
  goal('Rent 2027', '🏠', 1_500_000, 420_000, '2027-01-31');
  goal('Detty December', '🎉', 300_000, 85_000, `${now.getUTCFullYear()}-12-15`);
  world.roundUps.goal_id = world.goals[1]!.id;

  const lockAccount = ledger.openAccount({
    ownerType: 'customer',
    ownerId: userId,
    kind: 'customer_locked',
    currency: 'NGN',
  }).id;
  save(lockAccount, naira(200_000), 'Locked savings (90 days)');
  world.locks.push({
    id: newId(),
    accountId: lockAccount,
    principal: api(naira(200_000)),
    term_days: 90,
    rate_bps: 1_400,
    start_date: isoDate(now),
    maturity_date: isoDate(addDays(now, 90)),
    // 14% a year for 90 days on ₦200,000, rounded down: ₦6,904.10.
    expected_interest: api(money(690_410n, 'NGN')),
    early_break_penalty_bps: 5_000,
    status: 'active',
    paid_out: null,
  });

  seedAjo(draft, { now, reference, me });

  world.budgets.push(
    { id: newId(), category: 'food', limit: api(naira(60_000)), alert_at_pct: [80, 100] },
    { id: newId(), category: 'transport', limit: api(naira(90_000)), alert_at_pct: [80, 100] },
  );

  world.savedBillers.push(
    {
      id: newId(),
      biller_id: 'ikeja-electric-prepaid',
      biller_name: 'Ikeja Electric (prepaid)',
      category: 'electricity',
      customer_id: '45031234567',
      customer_name: 'TOLULOPE ADEBAYO',
      nickname: 'Home meter',
      created_at: at,
    },
    {
      id: newId(),
      biller_id: 'dstv',
      biller_name: 'DStv',
      category: 'cable_tv',
      customer_id: '7023456789',
      customer_name: 'T ADEBAYO',
      nickname: 'Living room',
      created_at: at,
    },
  );

  world.fxAlerts.push({
    id: newId(),
    pair: 'USD-NGN',
    direction: 'above',
    target_rate: '1650',
    status: 'active',
    created_at: at,
    triggered_at: null,
  });

  world.moneyRequests.push({
    id: newId(),
    direction: 'incoming',
    requester: party(world.people[0]!),
    payer: me,
    amount: api(naira(7_500)),
    note: 'Suya on Friday',
    status: 'pending',
    split_bill_id: null,
    transfer_id: null,
    created_at: at,
    expires_at: addDays(now, 7).toISOString(),
    responded_at: null,
  });

  addFriendPayLink(world, newId(), at);

  const conversationId = newId();
  world.conversations.push({
    id: conversationId,
    subject: 'Welcome to Nem',
    status: 'resolved',
    assigned_agent: 'Ada (Nem Support)',
    unread_count: 0,
    last_message_at: start.toISOString(),
    created_at: start.toISOString(),
  });
  world.messages.push({
    id: newId(),
    conversation_id: conversationId,
    sender: 'agent',
    sender_name: 'Ada (Nem Support)',
    body: 'Hi Tolu, welcome to Nem! Reply here any time you need help. Everything in this demo uses simulated money.',
    attachments: [],
    created_at: start.toISOString(),
    read_at: start.toISOString(),
  });

  world.kyc.documents.push(
    ...(['id_front', 'selfie', 'proof_of_address'] as const).map((kind) => ({
      id: newId(),
      kind,
      status: 'accepted' as const,
      uploaded_at: start.toISOString(),
    })),
  );
  world.kyc.submissions.push({
    id: newId(),
    target_tier: 3,
    status: 'approved',
    submitted_at: start.toISOString(),
    reviewed_at: addDays(start, 1).toISOString(),
    rejection_reason: null,
  });

  const [phone, web] = world.devices;
  world.sessions.push(
    {
      id: newId(),
      device_id: phone!.id,
      device_name: phone!.name,
      current: true,
      created_at: at,
      last_active_at: at,
      ip_location: 'Lagos, NG',
    },
    {
      id: newId(),
      device_id: web!.id,
      device_name: web!.name,
      current: false,
      created_at: addDays(now, -3).toISOString(),
      last_active_at: addDays(now, -1).toISOString(),
      ip_location: 'Lagos, NG',
    },
  );

  const note = (
    category: Schema<'NotificationCategory'>,
    title: string,
    body: string,
    deep_link: string,
    daysAgo: number,
  ) =>
    world.notifications.push({
      id: newId(),
      category,
      title,
      body,
      read: daysAgo > 2,
      deep_link,
      created_at: addDays(now, -daysAgo).toISOString(),
    });
  note(
    'security',
    'Security tip',
    'Nem will never ask for your PIN or OTP. Not on a call, not on WhatsApp.',
    'nembank://security',
    20,
  );
  note(
    'ajo',
    'Ajo payout to Amaka',
    'Cycle 1 of Lekki Girls Ajo paid out ₦100,000.00. Your payout is next.',
    'nembank://grow/ajo',
    1,
  );
  note('transactions', 'Amaka requested ₦7,500.00', 'Suya on Friday', 'nembank://pay/requests', 0);

  return world;
}

/** Ajo: five friends, ₦20,000 weekly. Cycle 1 paid Amaka; cycle 2 is collecting. */
export const FRIEND_PAY_LINK_SLUG = 'emeka-birthday';

/**
 * A friend's open-amount pay link, so the pay page can be tried from the app
 * (TRF-12). Also added to banks saved before it existed (see loadOrSeedBank).
 */
export function addFriendPayLink(world: World, id: string, at: string): void {
  const emeka = world.people[1];
  if (!emeka || world.paymentLinks.some((l) => l.slug === FRIEND_PAY_LINK_SLUG)) return;
  world.paymentLinks.push({
    id,
    slug: FRIEND_PAY_LINK_SLUG,
    url: `https://nem-bank-fodx.vercel.app/pay/${FRIEND_PAY_LINK_SLUG}`,
    account_id: emeka.accountId,
    title: "Emeka's birthday dinner",
    note: 'Chip in for Saturday at Yellow Chilli',
    amount_mode: 'open',
    amount: null,
    status: 'active',
    payments_count: 3,
    total_received: api(naira(45_000)),
    expires_at: null,
    created_at: at,
  });
}

function seedAjo(
  { world, ledger, newId, userId, ngn }: WorldDraft,
  { now, reference, me }: { now: Date; reference: () => string; me: Schema<'PartySummary'> },
) {
  const circle = [world.people[0]!, world.people[2]!, world.people[3]!, world.people[4]!];
  const groupId = newId();
  const escrow = ledger.openAccount({
    ownerType: 'system',
    ownerId: groupId,
    kind: 'ajo_escrow',
    currency: 'NGN',
  }).id;
  const contribution = naira(20_000);
  const contribute = (from: string) =>
    ledger.post({
      kind: 'ajo_contribution',
      reference: reference(),
      idempotencyKey: newId(),
      postings: [
        { accountId: from, amount: negate(contribution) },
        { accountId: escrow, amount: contribution },
      ],
      metadata:
        from === ngn
          ? {
              txns: [
                {
                  id: newId(),
                  accountId: ngn,
                  direction: 'debit',
                  type: 'ajo',
                  category: 'savings',
                  narration: 'Lekki Girls Ajo contribution',
                  counterparty: { name: 'Lekki Girls Ajo' },
                },
              ] satisfies TransactionMeta[],
            }
          : {},
    });
  for (const from of [ngn, ...circle.map((p) => p.accountId)]) contribute(from);
  ledger.post({
    kind: 'ajo_payout',
    reference: reference(),
    idempotencyKey: newId(),
    postings: [
      { accountId: escrow, amount: naira(-100_000) },
      { accountId: circle[0]!.accountId, amount: naira(100_000) },
    ],
  });
  for (const from of [ngn, circle[0]!.accountId, circle[1]!.accountId]) contribute(from);

  const order = [party(circle[0]!), me, party(circle[1]!), party(circle[2]!), party(circle[3]!)];
  const paidThisCycle = new Set([userId, circle[0]!.userId, circle[1]!.userId]);
  const week = (n: number) => addDays(now, 7 * n).toISOString();
  world.ajo.push({
    id: groupId,
    escrowAccountId: escrow,
    sourceAccountId: ngn,
    inviteCode: 'LEKKI5',
    name: 'Lekki Girls Ajo',
    contribution: api(contribution),
    frequency: 'weekly',
    member_count: 5,
    rotation: 'fixed',
    status: 'active',
    members: order.map((member, i) => ({
      member,
      position: i + 1,
      status: 'joined',
      has_received_payout: i === 0,
      contributions_paid: paidThisCycle.has(member.user_id) ? 2 : 1,
      missed_contributions: 0,
    })),
    current_cycle: 2,
    total_cycles: 5,
    next_contribution_at: week(1),
    next_payout: { member: me, amount: api(naira(100_000)), at: week(0.5) },
    grace_period_hours: 24,
    invite_url: 'https://nem-bank-fodx.vercel.app/ajo/LEKKI5',
    created_by: party(circle[0]!),
    created_at: addDays(now, -10).toISOString(),
    cycles: order.map((payout, i) => ({
      number: i + 1,
      due_at: week(i - 0.5),
      payout_to: payout,
      payout_amount: api(naira(100_000)),
      payout_status: i === 0 ? 'paid' : i === 1 ? 'collecting' : 'upcoming',
      contributions: order.map((m) => {
        const paid = i === 0 || (i === 1 && paidThisCycle.has(m.user_id));
        return {
          member: m,
          status: paid ? ('paid' as const) : ('pending' as const),
          paid_at: paid ? now.toISOString() : null,
          attempts: paid ? 1 : 0,
        };
      }),
    })),
  });
}

// Helpers shared by the seed and the savings/ajo domains.

/** Moves customer money into a goal, lock or escrow account as one entry. */
export function postSaving(
  ledger: Ledger,
  input: {
    from: string;
    to: string;
    amount: Money;
    reference: string;
    idempotencyKey: string;
    txn: Omit<TransactionMeta, 'accountId' | 'direction'>;
    kind?: 'savings' | 'ajo_contribution';
  },
): JournalEntry {
  return ledger.post({
    kind: input.kind ?? 'savings',
    reference: input.reference,
    idempotencyKey: input.idempotencyKey,
    postings: [
      { accountId: input.from, amount: negate(input.amount) },
      { accountId: input.to, amount: input.amount },
    ],
    metadata: { txns: [{ ...input.txn, accountId: input.from, direction: 'debit' }] },
  });
}
