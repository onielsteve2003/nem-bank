import type { Schema } from '@nem/contracts';
import { formatMoney, money, sum, toMajorString, zero } from '@nem/shared';

import { problem } from '../../errors';
import type { AccountsRepo, StatementsRepo, TransactionsRepo } from '../../repositories';
import { addDays, api, maskAccount, newestFirst, notFound, paginate } from '../convert';
import { NEM_BANK } from '../directory';
import { sha256Hex, textPdf } from '../documents';
import type { MockBank } from '../runtime';
import { accountName, accountView, customerTransactions, entryOf, transactionsFor } from '../views';

const HOLD_LABELS: Record<Schema<'HoldReason'>, string> = {
  card_authorization: 'Card payment waiting to settle',
  pending_transfer: 'Transfer on its way',
  delayed_transfer: 'New-beneficiary cooling-off',
  fraud_review: 'Held for a security review',
  ajo_contribution: 'Ajo contribution',
  dispute: 'Under dispute',
};

/** Days a customer can raise a dispute after a transaction (DSP-1). */
const DISPUTE_WINDOW_DAYS = 60;
const STATEMENT_READY_MS = 3_000;

export function accountsRepo(bank: MockBank): AccountsRepo {
  return {
    async list() {
      const order = ['NGN', 'USD', 'GBP', 'EUR'];
      return {
        data: bank
          .customerAccounts()
          .sort((a, b) => order.indexOf(a.currency) - order.indexOf(b.currency))
          .map((a) => accountView(bank, a)),
      };
    },
    async open({ body, idempotencyKey }) {
      bank.requireTier(2, 'Foreign-currency wallets');
      const account = bank.idempotent(
        idempotencyKey,
        body,
        (id) => bank.customerAccounts().find((a) => a.id === id),
        () => {
          if (bank.accountIn(body.currency)) {
            throw problem(409, 'account_exists', `You already have a ${body.currency} wallet`);
          }
          const opened = bank.ledger.openAccount({
            ownerType: 'customer',
            ownerId: bank.user.id,
            kind: 'customer_wallet',
            currency: body.currency,
          });
          const number = String(8_400_000_000 + Object.keys(bank.world.accountMeta).length * 7_919);
          bank.world.accountMeta[opened.id] = { accountNumber: number, nickname: null };
          return opened;
        },
      );
      return accountView(bank, account);
    },
    async get({ path }) {
      return accountView(bank, bank.ownAccount(path.account_id));
    },
    async listHolds({ path }) {
      const account = bank.ownAccount(path.account_id);
      const holds = bank.ledger
        .activeHolds(account.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return {
        data: holds.map((h) => ({
          id: h.id,
          account_id: h.accountId,
          amount: api(h.amount),
          reason: h.reason,
          reference: h.reference,
          description: HOLD_LABELS[h.reason],
          created_at: h.createdAt,
          expires_at: h.expiresAt,
        })),
        total: api(
          sum(
            holds.map((h) => h.amount),
            account.currency,
          ),
        ),
      };
    },
  };
}

function detail(bank: MockBank, id: string): Schema<'TransactionDetail'> {
  const txn = customerTransactions(bank).find((t) => t.id === id);
  if (!txn) throw notFound('Transaction');
  const entry = entryOf(bank, id);
  const transfer = bank.world.transfers.find((t) => t.id === txn.transfer_id);
  const dispute = bank.world.disputes.find(
    (d) => d.transaction_id === id && d.status !== 'withdrawn',
  );
  const fees: Schema<'FeeLine'>[] = [];
  if (txn.fee) {
    fees.push(
      txn.direction === 'credit'
        ? { code: 'emtl', label: 'Electronic Money Transfer Levy', amount: txn.fee }
        : { code: 'transfer_fee', label: 'Transfer fee', amount: txn.fee },
    );
  }
  const windowStart = addDays(bank.now(), -DISPUTE_WINDOW_DAYS).toISOString();
  return {
    ...txn,
    timeline: transfer?.timeline ?? [
      {
        status: txn.status,
        label: txn.status === 'completed' ? 'Completed' : txn.status,
        at: txn.created_at,
      },
    ],
    fees,
    journal_entry_id: entry?.id ?? txn.id,
    can_dispute:
      txn.direction === 'debit' &&
      txn.status === 'completed' &&
      !dispute &&
      txn.created_at >= windowStart,
    can_repeat: txn.type === 'transfer_out' && Boolean(transfer),
    dispute_id: dispute?.id ?? null,
  };
}

export function transactionsRepo(bank: MockBank): TransactionsRepo {
  return {
    async list({ query } = {}) {
      const q = query?.q?.trim().toLowerCase();
      const items = customerTransactions(bank).filter(
        (t) =>
          (!query?.account_id || t.account_id === query.account_id) &&
          (!query?.type?.length || query.type.includes(t.type)) &&
          (!query?.currency || t.amount.currency === query.currency) &&
          (!query?.status || t.status === query.status) &&
          (!query?.category || t.category === query.category) &&
          (!query?.from || t.created_at.slice(0, 10) >= query.from) &&
          (!query?.to || t.created_at.slice(0, 10) <= query.to) &&
          (!q ||
            [t.narration, t.counterparty.name, t.reference].some((f) =>
              f.toLowerCase().includes(q),
            )),
      );
      return paginate(items, query);
    },
    async get({ path }) {
      return detail(bank, path.transaction_id);
    },
    async update({ path, body }) {
      const txn = detail(bank, path.transaction_id);
      const targets = body.apply_to_similar
        ? customerTransactions(bank).filter((t) => t.counterparty.name === txn.counterparty.name)
        : [txn];
      for (const t of targets) bank.world.categoryOverrides[t.id] = body.category;
      return detail(bank, path.transaction_id);
    },
    async getReceipt({ path }) {
      const txn = detail(bank, path.transaction_id);
      const own = bank.world.accountMeta[txn.account_id]?.accountNumber ?? '';
      const us = {
        name: accountName(bank),
        account_number_masked: maskAccount(own),
        bank_name: NEM_BANK.name,
      };
      const them = {
        name: txn.counterparty.name,
        account_number_masked: txn.counterparty.account_number_masked ?? '—',
        bank_name: txn.counterparty.bank_name ?? NEM_BANK.name,
      };
      return {
        transaction_id: txn.id,
        reference: txn.reference,
        status: txn.status,
        amount: txn.amount,
        fee: txn.fee ?? api(zero(txn.amount.currency)),
        from: txn.direction === 'debit' ? us : them,
        to: txn.direction === 'debit' ? them : us,
        narration: txn.narration,
        created_at: txn.created_at,
        completed_at: txn.status === 'completed' ? txn.created_at : null,
        verification_code: sha256Hex(`${txn.id}:${txn.reference}`).slice(0, 10).toUpperCase(),
      };
    },
  };
}

/** Builds the statement figures once its period is known (the "generating" step). */
function generate(bank: MockBank, statement: Schema<'Statement'>) {
  const txns = transactionsFor(bank, [statement.account_id])
    .filter((t) => t.status === 'completed')
    .reverse();
  const before = txns.filter((t) => t.created_at.slice(0, 10) < statement.period_from);
  const within = txns.filter(
    (t) =>
      t.created_at.slice(0, 10) >= statement.period_from &&
      t.created_at.slice(0, 10) <= statement.period_to,
  );
  const currency = statement.currency;
  const opening = before.at(-1)?.balance_after ?? api(zero(currency));
  const closing = within.at(-1)?.balance_after ?? opening;
  const lines = within.map(
    (t) =>
      `${t.created_at.slice(0, 10)}  ${t.direction === 'debit' ? '-' : '+'}${toMajorString(money(t.amount.amount_minor, currency))}  ${t.narration}`,
  );
  const body = [statement.id, statement.period_from, statement.period_to, ...lines].join('\n');
  statement.status = 'ready';
  statement.opening_balance = opening;
  statement.closing_balance = closing;
  statement.sha256 = sha256Hex(body);
  statement.verification_code = statement.sha256.slice(0, 12).toUpperCase();
  statement.verification_url = `https://nem-bank-fodx.vercel.app/verify/${statement.verification_code}`;
}

export function processStatements(bank: MockBank): boolean {
  const cutoff = new Date(bank.now().getTime() - STATEMENT_READY_MS).toISOString();
  const due = bank.world.statements.filter(
    (s) => s.status === 'generating' && s.created_at <= cutoff,
  );
  for (const s of due) generate(bank, s);
  return due.length > 0;
}

export function statementsRepo(bank: MockBank): StatementsRepo {
  const find = (id: string) => {
    const s = bank.world.statements.find((x) => x.id === id);
    if (!s) throw notFound('Statement');
    return s;
  };
  return {
    async list({ query } = {}) {
      return paginate(newestFirst(bank.world.statements), query);
    },
    async request({ body }) {
      const account = bank.ownAccount(body.account_id);
      if (body.from > body.to)
        throw problem(422, 'validation_failed', 'The start date is after the end date');
      if (body.to > bank.nowIso().slice(0, 10)) {
        throw problem(422, 'validation_failed', 'Statements cannot cover future dates');
      }
      const statement: Schema<'Statement'> = {
        id: bank.id(),
        account_id: account.id,
        currency: account.currency,
        period_from: body.from,
        period_to: body.to,
        status: 'generating',
        opening_balance: null,
        closing_balance: null,
        sha256: null,
        verification_code: null,
        verification_url: null,
        created_at: bank.nowIso(),
      };
      bank.world.statements.push(statement);
      return statement;
    },
    async get({ path }) {
      return find(path.statement_id);
    },
    async download({ path }) {
      const s = find(path.statement_id);
      if (s.status !== 'ready') throw problem(409, 'statement_not_ready', 'Still generating');
      const opening = money(s.opening_balance!.amount_minor, s.currency);
      const closing = money(s.closing_balance!.amount_minor, s.currency);
      return textPdf([
        'Nem Bank (demo) - account statement. Simulated money, not a real bank document.',
        `${accountName(bank)}  ${maskAccount(bank.world.accountMeta[s.account_id]?.accountNumber ?? '')}`,
        `Period ${s.period_from} to ${s.period_to}`,
        `Opening balance ${formatMoney(opening)}   Closing balance ${formatMoney(closing)}`,
        `SHA-256 ${s.sha256}`,
        `Verify at ${s.verification_url}`,
      ]);
    },
  };
}
