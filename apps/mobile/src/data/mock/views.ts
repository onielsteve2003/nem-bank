import type { Schema } from '@nem/contracts';
import { KYC_TIERS, money, zero } from '@nem/shared';

import type { TransactionMeta } from './bank';
import { api, maskAccount } from './convert';
import { NEM_BANK } from './directory';
import type { JournalEntry, LedgerAccount } from './ledger';
import type { MockBank } from './runtime';
import type { Person, TransferRecord } from './world';
import { decoyBalance, inDuress } from './domains/duress';

// Read models: what the API would return, computed from the ledger on each read so
// a balance can never disagree with the postings behind it.

type Transaction = Schema<'Transaction'>;

export function accountName(bank: MockBank): string {
  return `${bank.user.first_name} ${bank.user.last_name}`;
}

export function accountView(bank: MockBank, account: LedgerAccount): Schema<'Account'> {
  const meta = bank.world.accountMeta[account.id];
  const accountNumber = meta?.accountNumber ?? '0000000000';
  const name = accountName(bank);
  const cap = KYC_TIERS[bank.tier()].maxBalance;
  const receiving: Schema<'ReceivingDetails'> =
    account.currency === 'NGN'
      ? {
          scheme: 'nuban',
          bank_name: NEM_BANK.name,
          bank_code: NEM_BANK.code,
          account_number: accountNumber,
          account_name: name,
          demo: true,
        }
      : account.currency === 'USD'
        ? {
            scheme: 'us_ach',
            bank_name: 'Nem Sandbox Partner Bank (demo)',
            account_number: accountNumber,
            routing_number: '021000000',
            account_type: 'checking',
            account_name: name,
            demo: true,
          }
        : account.currency === 'GBP'
          ? {
              scheme: 'uk_fps',
              bank_name: 'Nem Sandbox Partner Bank (demo)',
              sort_code: '04-00-00',
              account_number: accountNumber.slice(-8),
              account_name: name,
              demo: true,
            }
          : {
              scheme: 'iban',
              bank_name: 'Nem Sandbox Partner Bank (demo)',
              iban: `DE00500000${accountNumber}`,
              bic: 'NEMSDEFFXXX',
              account_name: name,
              demo: true,
            };
  return {
    id: account.id,
    currency: account.currency,
    kind: account.kind === 'customer_current' ? 'ngn_current' : 'fx_wallet',
    status: account.status,
    nickname: meta?.nickname ?? null,
    ...(inDuress(bank)
      ? {
          ledger_balance: api(decoyBalance(account.currency, account.balance)),
          available_balance: api(decoyBalance(account.currency, bank.ledger.available(account.id))),
        }
      : {
          ledger_balance: api(account.balance),
          available_balance: api(bank.ledger.available(account.id)),
        }),
    max_balance: cap && cap.currency === account.currency ? api(cap) : null,
    receiving_details: receiving,
    opened_at: account.createdAt,
  };
}

function metasOf(entry: JournalEntry): TransactionMeta[] {
  return (entry.metadata.txns as TransactionMeta[] | undefined) ?? [];
}

function fromEntry(
  bank: MockBank,
  entry: JournalEntry,
  meta: TransactionMeta,
  reversed: ReadonlySet<string>,
): Transaction {
  const postings = entry.postings.filter((p) => p.accountId === meta.accountId);
  const first = postings[0]!;
  const gross = first.amount.amount < 0n ? -first.amount.amount : first.amount.amount;
  const currency = first.amount.currency;
  // External sends carry their fee in the same debit; inbound EMTL is its own posting.
  const sendFee = BigInt(String(entry.metadata.fee ?? '0'));
  const levy = BigInt(String(entry.metadata.levy ?? '0'));
  const amount = meta.direction === 'debit' ? gross - sendFee : gross;
  const fee = meta.direction === 'debit' ? sendFee : levy;
  const override = bank.world.categoryOverrides[meta.id];
  return {
    id: meta.id,
    account_id: meta.accountId,
    type: meta.type,
    direction: meta.direction,
    status: reversed.has(entry.id) ? 'reversed' : 'completed',
    amount: api(money(amount, currency)),
    fee: fee > 0n ? api(money(fee, currency)) : null,
    balance_after: api(postings.at(-1)!.balanceAfter),
    narration: meta.narration,
    reference: entry.reference,
    category: override ?? meta.category,
    category_source: override ? 'user' : 'rules',
    counterparty: meta.counterparty,
    transfer_id: meta.transferId ?? null,
    card_id: meta.cardId ?? null,
    created_at: entry.createdAt,
  };
}

/** Transfers still in flight (or failed) have no settled entry, but do show in history. */
function fromTransfer(record: TransferRecord): Transaction | null {
  const live = ['processing', 'delayed', 'held_for_review', 'pending_step_up'];
  if (!record.transaction_id) return null;
  if (!live.includes(record.status) && record.status !== 'failed') return null;
  return {
    id: record.transaction_id,
    account_id: record.source_account_id,
    type: 'transfer_out',
    direction: 'debit',
    status: record.status === 'failed' ? 'failed' : 'pending',
    amount: record.amount,
    fee: record.fee.amount_minor === '0' ? null : record.fee,
    balance_after: null,
    narration: record.narration,
    reference: record.reference,
    category: record.category ?? 'transfers',
    category_source: 'rules',
    counterparty: {
      name: record.recipient.name,
      nemtag: record.recipient.nemtag ?? null,
      bank_name: record.recipient.bank_name,
      account_number_masked: record.recipient.account_number_masked,
    },
    transfer_id: record.id,
    card_id: null,
    created_at: record.created_at,
  };
}

/** Every transaction on the given accounts, newest first. */
export function transactionsFor(bank: MockBank, accountIds: readonly string[]): Transaction[] {
  const ids = new Set(accountIds);
  const reversed = new Set(
    bank.ledger.state.entries
      .map((e) => e.metadata.reverses)
      .filter((id): id is string => typeof id === 'string'),
  );
  const settled = bank.ledger.state.entries.flatMap((entry) =>
    metasOf(entry)
      .filter((m) => ids.has(m.accountId))
      .map((m) => fromEntry(bank, entry, m, reversed)),
  );
  const pending = bank.world.transfers
    .filter((t) => ids.has(t.source_account_id))
    .map(fromTransfer)
    .filter((t): t is Transaction => t !== null);
  // Newest first; entries posted in the same millisecond keep their ledger order.
  return [...settled, ...pending]
    .map((t, i) => [t, i] as const)
    .sort(([a, i], [b, j]) => b.created_at.localeCompare(a.created_at) || j - i)
    .map(([t]) => t);
}

export function customerTransactions(bank: MockBank): Transaction[] {
  return transactionsFor(
    bank,
    bank.customerAccounts().map((a) => a.id),
  );
}

/** The journal entry a transaction came from, for receipts and details. */
export function entryOf(bank: MockBank, transactionId: string): JournalEntry | undefined {
  return bank.ledger.state.entries.find((e) => metasOf(e).some((m) => m.id === transactionId));
}

export function partyOf(person: Person): Schema<'PartySummary'> {
  return {
    user_id: person.userId,
    name: `${person.firstName} ${person.lastName}`,
    nemtag: person.nemtag,
    avatar_url: null,
  };
}

export function me(bank: MockBank): Schema<'PartySummary'> {
  return {
    user_id: bank.user.id,
    name: accountName(bank),
    nemtag: bank.user.nemtag,
    avatar_url: bank.user.avatar_url ?? null,
  };
}

export function personByNemtag(bank: MockBank, nemtag: string): Person | undefined {
  const tag = nemtag.replace(/^@/, '').toLowerCase();
  return bank.world.people.find((p) => p.nemtag === tag);
}

export function nemParty(person: Person): Schema<'TransferParty'> {
  return {
    name: `${person.firstName} ${person.lastName}`,
    nemtag: person.nemtag,
    bank_code: NEM_BANK.code,
    bank_name: NEM_BANK.name,
    account_number_masked: maskAccount(person.accountNumber),
  };
}

/** Strips the mock's bookkeeping fields from a stored transfer. */
export function transferView(record: TransferRecord): Schema<'Transfer'> {
  const {
    destination: _destination,
    beneficiaryId: _beneficiaryId,
    holdId: _holdId,
    dueAt: _dueAt,
    category: _category,
    paysRequestId: _paysRequestId,
    willFail: _willFail,
    ...transfer
  } = record;
  return transfer;
}

export const ngnZero = () => api(zero('NGN'));
