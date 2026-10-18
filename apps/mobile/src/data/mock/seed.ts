import type { User } from '@nem/contracts';
import { money, negate, type Money } from '@nem/shared';

import { isApiError } from '../errors';
import { SCHEMA_VERSION, type MockBankState, type TransactionMeta } from './bank';
import { createIdFactory, seededRandom } from './ids';
import {
  convertFx,
  demoFund,
  emptyLedgerState,
  Ledger,
  receiveExternal,
  settleExternalTransfer,
  startExternalTransfer,
} from './ledger';
import { finishWorld, SEED_FRIENDS, startWorld, type SeedFriend } from './seedWorld';

// Tolu, 26, a Lagos tech worker (PRD §4): NGN salary, USD freelance income, and
// six months of everyday Nigerian spending. Same seed + same day = same history.

const HISTORY_DAYS = 182;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Lagos is UTC+1 all year. */
const LAGOS_OFFSET = HOUR;

type Spend = Omit<TransactionMeta, 'id' | 'accountId' | 'direction'>;

interface Merchant {
  name: string;
  min: number;
  max: number;
}

const RIDES: Merchant[] = [
  { name: 'Bolt', min: 1_800, max: 6_500 },
  { name: 'Uber', min: 2_000, max: 7_000 },
  { name: 'Danfo fare (Opay POS)', min: 300, max: 1_200 },
];
const FOOD: Merchant[] = [
  { name: 'Chicken Republic', min: 2_500, max: 7_500 },
  { name: "Iya Basira's Kitchen", min: 1_500, max: 4_000 },
  { name: 'Kilimanjaro', min: 3_000, max: 8_000 },
  { name: "Domino's Pizza", min: 6_500, max: 14_000 },
  { name: 'Cafe Neo', min: 2_800, max: 6_000 },
];
const GROCERIES: Merchant[] = [
  { name: 'Shoprite Lekki', min: 18_000, max: 48_000 },
  { name: 'Spar Ikeja City Mall', min: 15_000, max: 42_000 },
  { name: 'Market Square', min: 12_000, max: 35_000 },
];
const FRIENDS = SEED_FRIENDS.filter((f) => !f.family);

interface Monthly {
  day: number;
  spend: Spend;
  amount: number;
}

const MONTHLY_BILLS: Monthly[] = [
  {
    day: 1,
    amount: 19_000,
    spend: bill('DStv Compact', 'subscriptions', 'DStv Compact renewal'),
  },
  { day: 3, amount: 7_000, spend: card('Netflix', 'subscriptions', 'Netflix Standard') },
  { day: 10, amount: 1_900, spend: card('Spotify', 'subscriptions', 'Spotify Premium') },
  {
    day: 12,
    amount: 15_000,
    spend: bill('Ikeja Electric', 'bills_utilities', 'Ikeja Electric prepaid token'),
  },
  { day: 15, amount: 5_000, spend: bill('MTN', 'airtime_data', 'MTN 10GB monthly data') },
];

function card(name: string, category: Spend['category'], narration?: string): Spend {
  return {
    type: 'card_payment',
    category,
    narration: narration ?? name,
    counterparty: { name, merchant_id: null },
  };
}

function bill(name: string, category: Spend['category'], narration: string): Spend {
  return { type: 'bill_payment', category, narration, counterparty: { name } };
}

export interface SeedOptions {
  now: Date;
  seed: number;
}

export function seedDemoBank({ now, seed }: SeedOptions): MockBankState {
  const random = seededRandom(seed);
  // History ends at the start of today (Lagos), so a re-seed on the same day matches.
  const todayStart = Math.floor((now.getTime() + LAGOS_OFFSET) / DAY) * DAY - LAGOS_OFFSET;
  const start = todayStart - HISTORY_DAYS * DAY;
  let cursor = new Date(start);
  const clock = () => cursor;
  const newId = createIdFactory(clock, random);
  const ledger = new Ledger(emptyLedgerState(), { now: clock, newId });

  const between = (min: number, max: number, step = 50) =>
    Math.round((min + random() * (max - min)) / step) * step;
  const naira = (major: number) => money(BigInt(major) * 100n, 'NGN');
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  const chance = (p: number) => random() < p;
  let sequence = 0;
  const reference = () => {
    const date = cursor.toISOString().slice(0, 10).replaceAll('-', '');
    sequence += 1;
    return `NEM${date}${sequence.toString(36).toUpperCase().padStart(6, '0')}`;
  };

  const userId = newId();
  const ngn = ledger.openAccount({
    ownerType: 'customer',
    ownerId: userId,
    kind: 'customer_current',
    currency: 'NGN',
  }).id;
  const usd = ledger.openAccount({
    ownerType: 'customer',
    ownerId: userId,
    kind: 'customer_wallet',
    currency: 'USD',
  }).id;

  const world = startWorld({ ledger, newId, random, userId, ngn, usd });
  const meta = (accountId: string, direction: TransactionMeta['direction'], spend: Spend) => ({
    txns: [{ id: newId(), accountId, direction, ...spend }] satisfies TransactionMeta[],
  });

  // Spending the persona cannot afford is skipped, as a real customer's would be.
  const attempt = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      if (!isApiError(error)) throw error;
    }
  };

  const spendFromCard = (amount: Money, spend: Spend, settlement: 'card' | 'biller') =>
    attempt(() => {
      ledger.post({
        kind: settlement === 'card' ? 'card_settlement' : 'bill_payment',
        reference: reference(),
        idempotencyKey: newId(),
        postings: [
          { accountId: ngn, amount: negate(amount) },
          {
            accountId: ledger.systemAccount(
              settlement === 'card' ? 'card_settlement' : 'partner_settlement',
              'NGN',
            ).id,
            amount,
          },
        ],
        metadata: meta(
          ngn,
          'debit',
          settlement === 'card' ? { ...spend, cardId: world.cards[0]!.id } : spend,
        ),
      });
    });

  const sendExternal = (amount: Money, to: SeedFriend, note: string) =>
    attempt(() => {
      const ref = reference();
      const hold = startExternalTransfer(ledger, {
        fromAccountId: ngn,
        amount,
        reference: ref,
        idempotencyKey: newId(),
        limits: { tier: 3 },
      });
      const transferId = newId();
      const txn = meta(ngn, 'debit', {
        type: 'transfer_out',
        category: to.family ? 'family' : 'transfers',
        narration: note,
        counterparty: {
          name: to.name,
          bank_name: to.bank_name,
          account_number_masked: `******${to.account_number.slice(-4)}`,
        },
        transferId,
      });
      const entry = settleExternalTransfer(ledger, hold.id, newId(), txn);
      world.recordSettledTransfer({
        id: transferId,
        entry,
        to,
        note,
        transactionId: txn.txns[0]!.id,
      });
    });

  // Opening balance on day one.
  demoFund(ledger, { toAccountId: ngn, amount: naira(180_000), tier: 3, idempotencyKey: newId() });

  let fxRate = 1_585; // NGN per USD, drifting a little each day.
  for (let day = 0; day < HISTORY_DAYS; day++) {
    const dayStart = start + day * DAY;
    const lagos = new Date(dayStart + LAGOS_OFFSET);
    const dayOfMonth = lagos.getUTCDate();
    const weekday = lagos.getUTCDay();
    const isWeekday = weekday >= 1 && weekday <= 5;
    fxRate = Math.min(1_680, Math.max(1_490, fxRate + between(-6, 6, 1)));

    const events: { at: number; run: () => void }[] = [];
    // Hours are Lagos time; dayStart is already Lagos midnight.
    const at = (fromHour: number, toHour: number, run: () => void) =>
      events.push({ at: dayStart + between(fromHour * 60, toHour * 60, 1) * 60_000, run });

    if (dayOfMonth === 25) {
      at(8, 10, () =>
        receiveExternal(ledger, {
          toAccountId: ngn,
          amount: naira(650_000),
          tier: 3,
          reference: reference(),
          idempotencyKey: newId(),
          metadata: meta(ngn, 'credit', {
            type: 'transfer_in',
            category: 'salary_income',
            narration: 'Salary - Kora Labs Ltd',
            counterparty: {
              name: 'Kora Labs Ltd',
              bank_name: 'Guaranty Trust Bank',
              account_number_masked: '******2210',
            },
          }),
        }),
      );
    }
    if (dayOfMonth === 26)
      at(9, 12, () =>
        sendExternal(
          naira(50_000),
          SEED_FRIENDS.find((f) => f.family)!,
          'Upkeep',
        ),
      );
    for (const monthly of MONTHLY_BILLS) {
      if (dayOfMonth === monthly.day) {
        const settlement = monthly.spend.type === 'card_payment' ? 'card' : 'biller';
        at(6, 9, () => spendFromCard(naira(monthly.amount), monthly.spend, settlement));
      }
    }
    if (isWeekday) {
      if (chance(0.75)) {
        const ride = pick(RIDES);
        at(7, 9, () =>
          spendFromCard(
            naira(between(ride.min, ride.max)),
            card(ride.name, 'transport', `${ride.name} trip`),
            'card',
          ),
        );
      }
      if (chance(0.6)) {
        const ride = pick(RIDES);
        at(17, 20, () =>
          spendFromCard(
            naira(between(ride.min, ride.max)),
            card(ride.name, 'transport', `${ride.name} trip`),
            'card',
          ),
        );
      }
    }
    if (chance(0.65)) {
      const food = pick(FOOD);
      at(12, 21, () =>
        spendFromCard(naira(between(food.min, food.max)), card(food.name, 'food'), 'card'),
      );
    }
    if (weekday === 6) {
      const store = pick(GROCERIES);
      at(10, 16, () =>
        spendFromCard(
          naira(between(store.min, store.max, 100)),
          card(store.name, 'groceries'),
          'card',
        ),
      );
    }
    if (chance(1 / 6)) {
      const network = pick(['MTN', 'Airtel', 'Glo']);
      at(8, 22, () =>
        spendFromCard(
          naira(pick([500, 1_000, 1_500, 2_000])),
          bill(network, 'airtime_data', `${network} airtime`),
          'biller',
        ),
      );
    }
    if (chance(0.07)) {
      const friend = pick(FRIENDS);
      at(10, 22, () =>
        sendExternal(
          naira(between(5_000, 30_000, 500)),
          friend,
          pick(['Lunch money', 'Thanks!', 'Owambe aso-ebi', 'Fuel']),
        ),
      );
    }
    // Freelance income in dollars about every six weeks, half of it converted to naira.
    if (day % 42 === 20) {
      const dollars = money(BigInt(between(400, 900, 25)) * 100n, 'USD');
      at(15, 18, () => {
        receiveExternal(ledger, {
          toAccountId: usd,
          amount: dollars,
          tier: 3,
          reference: reference(),
          idempotencyKey: newId(),
          metadata: meta(usd, 'credit', {
            type: 'transfer_in',
            category: 'salary_income',
            narration: 'Invoice payment - Northwind Studio',
            counterparty: { name: 'Northwind Studio LLC', bank_name: 'Silicon Valley Payments' },
          }),
        });
        const sell = money(dollars.amount / 2n, 'USD');
        const fx = (direction: TransactionMeta['direction'], accountId: string) => ({
          id: newId(),
          accountId,
          direction,
          type: 'fx_conversion' as const,
          category: 'transfers' as const,
          narration: 'Converted USD to NGN',
          counterparty: { name: 'Nem FX' },
        });
        convertFx(ledger, {
          fromAccountId: usd,
          toAccountId: ngn,
          sell,
          rate: String(fxRate),
          reference: reference(),
          idempotencyKey: newId(),
          toTier: 3,
          metadata: { txns: [fx('debit', usd), fx('credit', ngn)] satisfies TransactionMeta[] },
        });
      });
    }

    events.sort((a, b) => a.at - b.at);
    for (const event of events) {
      cursor = new Date(event.at);
      event.run();
    }
  }

  cursor = new Date(todayStart);
  const finished = finishWorld(world, { now: cursor, start: new Date(start), reference });

  const user: User = {
    id: userId,
    first_name: 'Tolulope',
    last_name: 'Adebayo',
    preferred_name: 'Tolu',
    email: 'tolu.demo@example.com',
    phone: '+2348031234567',
    date_of_birth: '2000-03-14',
    nemtag: 'tolu_a',
    avatar_url: null,
    kyc_tier: 3,
    kyc_status: 'approved',
    has_pin: true,
    is_demo: true,
    is_dependant: false,
    created_at: new Date(start).toISOString(),
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    seed,
    seededAt: new Date(todayStart).toISOString(),
    user,
    accounts: { ngn, usd },
    ledger: ledger.state,
    world: finished,
  };
}
