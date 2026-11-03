import type { CurrencyCode, Schema } from '@nem/contracts';

import { lagosDate } from '@/lib/dates';

import { problem } from '../errors';
import type { Handlers } from './handlers';
import { PARTNER, type JournalEntry } from './ledgerSeed';
import { paginate } from './paging';
import type { MockState } from './state';

type Item = Schema<'ReconciliationItem'>;

const money = (amount: bigint, currency: CurrencyCode) => ({
  amount_minor: amount.toString(),
  currency,
});

const day = (iso: string) => lagosDate(Date.parse(iso));
const inRange = (iso: string, from?: string, to?: string) =>
  (!from || day(iso) >= from) && (!to || day(iso) <= to);

function findEntry(state: MockState, entryId: string): JournalEntry {
  const found = state.ledger.entries.find((e) => e.id === entryId);
  if (!found) throw problem(404, 'not_found', 'No journal entry with that ID');
  return found;
}

/** The partner's settlement lines for one day: what NIBSS says moved, by reference. */
function partnerFile(ledgerLines: Map<string, bigint>, date: string): Map<string, bigint> {
  const file = new Map(ledgerLines);
  const refs = [...ledgerLines.keys()];
  // The sandbox partner drops one line, misreports one amount, and on even days sends
  // a line the ledger never saw: the three breaks a real reconciliation must catch.
  if (refs[1]) file.delete(refs[1]);
  if (refs[2]) file.set(refs[2], ledgerLines.get(refs[2])! + 100_00n);
  if (Number(date.slice(-2)) % 2 === 0)
    file.set(`NIBSS${date.replaceAll('-', '')}000417`, 25_000_00n);
  return file;
}

export const ledgerHandlers: Handlers = {
  listLedgerAccounts: ({ query } = {}, { state }) => {
    const rows = [...state.ledger.accounts.values()]
      .filter((a) => !query?.owner_type || a.owner_type === query.owner_type)
      .filter((a) => !query?.owner_id || a.owner_id === query.owner_id)
      .filter((a) => !query?.currency || a.currency === query.currency)
      // The bank's own accounts first, then customers by name.
      .sort(
        (a, b) =>
          b.owner_type.localeCompare(a.owner_type) || (a.name ?? '').localeCompare(b.name ?? ''),
      )
      .map((a) => structuredClone(a));
    return paginate(rows, query?.cursor, query?.limit);
  },

  listLedgerPostings: ({ path, query }, { state }) => {
    if (!state.ledger.accounts.has(path.ledger_account_id)) {
      throw problem(404, 'not_found', 'No ledger account with that ID');
    }
    const rows = state.ledger.entries
      .flatMap((e) => e.postings)
      .filter((p) => p.account_id === path.ledger_account_id)
      .filter((p) => inRange(p.created_at, query?.from, query?.to))
      .reverse();
    return paginate(structuredClone(rows), query?.cursor, query?.limit);
  },

  listJournalEntries: ({ query } = {}, { state }) => {
    const ref = query?.reference?.trim().toUpperCase();
    const rows = state.ledger.entries
      .filter((e) => !query?.kind || e.kind === query.kind)
      .filter((e) => !ref || e.reference.toUpperCase().includes(ref))
      .filter((e) => inRange(e.created_at, query?.from, query?.to))
      .slice()
      .reverse();
    return paginate(structuredClone(rows), query?.cursor, query?.limit);
  },

  getJournalEntry: ({ path }, { state }) => structuredClone(findEntry(state, path.entry_id)),

  getTrialBalance: ({ query } = {}, { state }) => {
    const started = performance.now();
    const asOf = query?.as_of ?? new Date(state.now()).toISOString();
    const totals = new Map<CurrencyCode, { debits: bigint; credits: bigint }>();
    for (const entry of state.ledger.entries) {
      if (entry.created_at > asOf) break;
      for (const p of entry.postings) {
        const amount = BigInt(p.amount.amount_minor);
        const t = totals.get(p.amount.currency) ?? { debits: 0n, credits: 0n };
        if (amount < 0n) t.debits -= amount;
        else t.credits += amount;
        totals.set(p.amount.currency, t);
      }
    }
    const accounts = [...state.ledger.accounts.values()];
    const currencies = [...totals]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, t]) => ({
        currency,
        total_debits: money(t.debits, currency),
        total_credits: money(t.credits, currency),
        net: money(t.credits - t.debits, currency),
        balanced: t.credits === t.debits,
        accounts: accounts.filter((a) => a.currency === currency).length,
      }));
    return {
      as_of: asOf,
      balanced: currencies.every((c) => c.balanced),
      currencies,
      generated_in_ms: Math.max(1, Math.round(performance.now() - started)),
    };
  },

  getReconciliationReport: ({ query }, { state }) => {
    const today = lagosDate(state.now());
    if (query.date >= today) {
      throw problem(404, 'not_found', 'The partner file for this day is not in yet', {
        detail: 'Settlement files arrive the morning after. Pick an earlier day.',
      });
    }
    if (query.date < state.ledger.firstDay) {
      throw problem(404, 'not_found', 'No settlement history for that day');
    }

    // What the ledger says crossed the partner account that day, by reference.
    const settlement = [...state.ledger.accounts.values()].find(
      (a) => a.kind === 'partner_settlement',
    )!;
    const ledgerLines = new Map<string, bigint>();
    for (const e of state.ledger.entries) {
      if (day(e.created_at) !== query.date) continue;
      const leg = e.postings.find((p) => p.account_id === settlement.id);
      if (leg) ledgerLines.set(e.reference, BigInt(leg.amount.amount_minor));
    }
    const partner = partnerFile(ledgerLines, query.date);

    const items: Item[] = [];
    let matched = 0;
    const abs = (n: bigint) => money(n < 0n ? -n : n, settlement.currency);
    for (const [reference, amount] of ledgerLines) {
      const theirs = partner.get(reference);
      if (theirs === undefined) {
        items.push({
          reference,
          ledger_amount: abs(amount),
          partner_amount: null,
          status: 'missing_at_partner',
        });
      } else if (theirs !== amount) {
        items.push({
          reference,
          ledger_amount: abs(amount),
          partner_amount: abs(theirs),
          status: 'amount_mismatch',
        });
      } else matched += 1;
    }
    for (const [reference, amount] of partner) {
      if (!ledgerLines.has(reference)) {
        items.push({
          reference,
          ledger_amount: null,
          partner_amount: abs(amount),
          status: 'missing_in_ledger',
        });
      }
    }
    return {
      date: query.date,
      partner: PARTNER,
      matched,
      unmatched: items.length,
      items,
      generated_at: new Date(state.now()).toISOString(),
    };
  },
};
