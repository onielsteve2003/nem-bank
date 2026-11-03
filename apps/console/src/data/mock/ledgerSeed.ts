import type { CurrencyCode, Schema } from '@nem/contracts';

import { EMTL, money as sharedMoney, transferFee } from '@nem/shared';

import { lagosDate } from '@/lib/dates';

import type { CustomerRecord } from './customerSeed';

// A small double-entry ledger behind the explorer (ADM-7). Every entry is posted
// through `post`, which refuses one whose postings don't sum to zero per currency,
// so the trial balance is computed from real postings, never typed in.
// Signs follow the contract: credits positive, debits negative.

export type LedgerAccount = Schema<'LedgerAccount'>;
export type JournalEntry = Schema<'JournalEntry'>;
type Kind = Schema<'LedgerAccountKind'>;

export interface LedgerState {
  accounts: Map<string, LedgerAccount>;
  /** Oldest first. */
  entries: JournalEntry[];
  /** First day with entries (Lagos), so reconciliation knows where history starts. */
  firstDay: string;
}

export const PARTNER = 'NIBSS settlement (sandbox)';

const SYSTEM: readonly [kind: Kind, name: string, currencies: CurrencyCode[]][] = [
  ['demo_funding', 'Demo funding', ['NGN', 'USD']],
  ['partner_settlement', 'Partner settlement', ['NGN']],
  ['card_settlement', 'Card settlement', ['NGN', 'USD']],
  ['fee_income', 'Fee income', ['NGN']],
  ['levy_payable', 'EMTL levy payable', ['NGN']],
  ['fx_position', 'FX position', ['NGN', 'USD']],
  ['interest_expense', 'Interest expense', ['NGN']],
  ['ajo_escrow', 'Ajo escrow', ['NGN']],
  ['suspense', 'Suspense', ['NGN', 'USD']],
];

const hex = (prefix: string, n: number) =>
  `01900000-0000-7000-8000-${prefix}${String(n).padStart(12 - prefix.length, '0')}`;
export const systemAccountId = (kind: Kind, currency: CurrencyCode) =>
  hex('5a', SYSTEM.findIndex(([k]) => k === kind) * 10 + (currency === 'NGN' ? 0 : 1));

const money = (amount: bigint, currency: CurrencyCode) => ({
  amount_minor: amount.toString(),
  currency,
});

export interface EntryInput {
  kind: JournalEntry['kind'];
  reference: string;
  at: string;
  postings: [accountId: string, amount: bigint][];
  metadata?: Record<string, unknown>;
  idempotencyKey?: string | null;
  approvalId?: string | null;
}

/** Posts one balanced entry and moves every balance it touches. */
export function post(ledger: LedgerState, input: EntryInput, id?: string): JournalEntry {
  const net = new Map<CurrencyCode, bigint>();
  const accounts = input.postings.map(([accountId, amount]) => {
    const account = ledger.accounts.get(accountId);
    if (!account) throw new Error(`No ledger account ${accountId}`);
    net.set(account.currency, (net.get(account.currency) ?? 0n) + amount);
    return account;
  });
  for (const [currency, sum] of net) {
    if (sum !== 0n) throw new Error(`Unbalanced ${currency} entry ${input.reference}: ${sum}`);
  }

  const entryId = id ?? hex('6e', ledger.entries.length + 1);
  const entry: JournalEntry = {
    id: entryId,
    kind: input.kind,
    reference: input.reference,
    idempotency_key: input.idempotencyKey ?? null,
    metadata: input.metadata ?? {},
    approval_id: input.approvalId ?? null,
    created_at: input.at,
    postings: input.postings.map(([, amount], i) => {
      const account = accounts[i]!;
      const balance = BigInt(account.balance.amount_minor) + amount;
      account.balance = money(balance, account.currency);
      account.available = money(balance, account.currency);
      account.version += 1;
      return {
        id: hex('7e', (ledger.entries.length + 1) * 10 + i),
        entry_id: entryId,
        account_id: account.id,
        amount: money(amount, account.currency),
        balance_after: money(balance, account.currency),
        created_at: input.at,
      };
    }),
  };
  ledger.entries.push(entry);
  return entry;
}

const DAY = 86_400_000;
const nairaMinor = (minor: bigint) => sharedMoney(minor, 'NGN');

/** Ledger accounts for every customer account plus the bank's own, with 14 days of history. */
export function seedLedger(customers: Map<string, CustomerRecord>, now: number): LedgerState {
  const accounts = new Map<string, LedgerAccount>();
  const open = (a: Omit<LedgerAccount, 'balance' | 'available' | 'version'>) =>
    accounts.set(a.id, {
      ...a,
      balance: money(0n, a.currency),
      available: money(0n, a.currency),
      version: 0,
    });

  for (const [kind, name, currencies] of SYSTEM) {
    for (const currency of currencies) {
      open({
        id: systemAccountId(kind, currency),
        owner_type: 'system',
        owner_id: null,
        kind,
        currency,
        name: `${name} (${currency})`,
        created_at: '2026-09-01T00:00:00Z',
      });
    }
  }
  const records = [...customers.values()];
  for (const { view } of records) {
    for (const a of view.accounts) {
      open({
        id: a.id,
        owner_type: 'customer',
        owner_id: view.customer.user_id,
        kind: a.kind === 'fx_wallet' ? 'customer_wallet' : 'customer_current',
        currency: a.currency,
        name: `${view.customer.name} · ${a.currency} ${a.kind === 'fx_wallet' ? 'wallet' : 'current'}`,
        created_at: a.opened_at,
      });
    }
  }

  // Everyday activity for the last 14 days: transfers out (with fee and stamp-duty levy),
  // transfers in, card spend and an FX conversion. Amounts are small slices of each
  // balance, so the opening funding below can always cover them.
  const plans: EntryInput[] = [];
  const ngn = (sys: Kind) => systemAccountId(sys, 'NGN');
  records.forEach(({ view }, c) => {
    const account = view.accounts[0]!;
    const target = BigInt(account.ledger_balance.amount_minor);
    const slice = (target / 40n / 100n) * 100n;
    if (slice < 100_00n) return;
    for (let d = 13; d >= 0; d -= 1) {
      const at = now - d * DAY - ((c * 37 + d * 11) % 600) * 60_000;
      if (at < Date.parse(account.opened_at) + DAY) continue;
      const iso = new Date(at).toISOString();
      const ref = (tag: string) =>
        `NEM${lagosDate(at).replaceAll('-', '')}${tag}${String(c).padStart(2, '0')}${d}`;
      const step = (c + d) % 4;
      if (step === 0) {
        const fee = transferFee(nairaMinor(slice), 'external').amount;
        plans.push({
          kind: 'transfer_external',
          reference: ref('X'),
          at: iso,
          postings: [
            [account.id, -(slice + fee)],
            [ngn('partner_settlement'), slice],
            [ngn('fee_income'), fee],
          ],
          metadata: { rail: 'nip', direction: 'out' },
        });
      } else if (step === 1) {
        const amount = slice * 2n;
        plans.push({
          kind: 'transfer_external',
          reference: ref('R'),
          at: iso,
          postings: [
            [ngn('partner_settlement'), -amount],
            [account.id, amount - EMTL.levy.amount],
            [ngn('levy_payable'), EMTL.levy.amount],
          ],
          metadata: { rail: 'nip', direction: 'in', levy: 'EMTL' },
        });
      } else if (step === 2) {
        plans.push({
          kind: 'card_settlement',
          reference: ref('C'),
          at: iso,
          postings: [
            [account.id, -slice / 2n],
            [ngn('card_settlement'), slice / 2n],
          ],
          metadata: { scheme: 'verve-sim' },
        });
      }
    }
    const usd = view.accounts.find((a) => a.currency === 'USD');
    if (usd) {
      const at = now - (3 + (c % 5)) * DAY;
      const usdAmount = 50_00n;
      const ngnAmount = usdAmount * 1_610n; // ₦1,610 per $1, including spread
      plans.push({
        kind: 'fx_conversion',
        reference: `NEMFX${lagosDate(at).replaceAll('-', '')}${c}`,
        at: new Date(at).toISOString(),
        postings: [
          [account.id, -ngnAmount],
          [ngn('fx_position'), ngnAmount],
          [systemAccountId('fx_position', 'USD'), -usdAmount],
          [usd.id, usdAmount],
        ],
        metadata: { pair: 'NGN/USD', rate: '1610.00' },
      });
    }
  });

  // Opening funding brings each customer account to the balance its 360 shows.
  const net = new Map<string, bigint>();
  for (const p of plans) {
    for (const [id, amount] of p.postings) net.set(id, (net.get(id) ?? 0n) + amount);
  }
  for (const { view } of records) {
    for (const a of view.accounts) {
      const opening = BigInt(a.ledger_balance.amount_minor) - (net.get(a.id) ?? 0n);
      if (opening === 0n) continue;
      plans.push({
        kind: 'demo_funding',
        reference: `NEMOPEN${a.id.slice(-6)}`,
        at: a.opened_at,
        postings: [
          [systemAccountId('demo_funding', a.currency), -opening],
          [a.id, opening],
        ],
        metadata: { note: 'Demo opening balance' },
      });
    }
  }

  const ledger: LedgerState = {
    accounts,
    entries: [],
    firstDay: lagosDate(now - 13 * DAY),
  };
  plans.sort((a, b) => a.at.localeCompare(b.at)).forEach((p) => post(ledger, p));
  return ledger;
}
