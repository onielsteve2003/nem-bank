import type { CurrencyCode } from '@nem/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';

import { MoneyText } from '@/components/MoneyText';
import { EmptyState, ErrorState, Skeleton } from '@/components/PageState';
import { formatDateTime } from '@/lib/dates';

import { ENTRY_KINDS } from './labels';
import { LedgerTabs } from './LedgerTabs';
import {
  useJournalEntries,
  type EntryFilters,
  type EntryKind,
  type JournalEntry,
} from './useLedger';

/** An entry's size: the credits in each currency (they equal the debits). */
export function entryTotals(entry: JournalEntry) {
  const totals = new Map<CurrencyCode, bigint>();
  for (const p of entry.postings) {
    const amount = BigInt(p.amount.amount_minor);
    if (amount > 0n) totals.set(p.amount.currency, (totals.get(p.amount.currency) ?? 0n) + amount);
  }
  return [...totals].map(([currency, amount]) => ({
    amount_minor: amount.toString(),
    currency,
  }));
}

export function JournalPage({ filters }: { filters: EntryFilters }) {
  const navigate = useNavigate();
  const entries = useJournalEntries(filters);
  const rows = entries.data?.pages.flatMap((p) => p.data) ?? [];
  const [reference, setReference] = useState(filters.reference ?? '');
  const filtered = Boolean(filters.kind || filters.reference || filters.from || filters.to);

  const apply = (next: EntryFilters) =>
    void navigate({ to: '/ledger', search: { ...filters, ...next } });
  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    apply({ reference: reference.trim() || undefined });
  };

  return (
    <>
      <div className="stack tight">
        <h1>Ledger</h1>
        <p className="muted">Every journal entry, newest first. Each one balances to zero.</p>
      </div>
      <LedgerTabs />

      <form className="row filters" onSubmit={onSearch} aria-label="Filter entries">
        <label className="field">
          Kind
          <select
            className="select"
            value={filters.kind ?? ''}
            onChange={(e) =>
              apply({ kind: (e.target.value || undefined) as EntryKind | undefined })
            }
          >
            <option value="">All kinds</option>
            {Object.entries(ENTRY_KINDS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          From
          <input
            type="date"
            className="input"
            value={filters.from ?? ''}
            onChange={(e) => apply({ from: e.target.value || undefined })}
          />
        </label>
        <label className="field">
          To
          <input
            type="date"
            className="input"
            value={filters.to ?? ''}
            onChange={(e) => apply({ to: e.target.value || undefined })}
          />
        </label>
        <label className="field grow">
          Reference
          <input
            className="input num"
            value={reference}
            placeholder="NEM2026…"
            maxLength={60}
            onChange={(e) => setReference(e.target.value)}
          />
        </label>
        <button type="submit" className="btn">
          Search
        </button>
        {filtered && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setReference('');
              void navigate({ to: '/ledger', search: {} });
            }}
          >
            Clear
          </button>
        )}
      </form>

      {entries.isPending ? (
        <div className="card stack" aria-busy="true" aria-label="Loading entries">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} height={24} />
          ))}
        </div>
      ) : entries.isError ? (
        <ErrorState error={entries.error} onRetry={() => void entries.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No entries">
          {filtered ? 'Nothing matches these filters.' : 'The ledger is empty.'}
        </EmptyState>
      ) : (
        <section className="card stack" aria-label="Journal entries" aria-busy={entries.isFetching}>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Posted</th>
                <th scope="col">Kind</th>
                <th scope="col">Reference</th>
                <th scope="col" className="numeric">
                  Postings
                </th>
                <th scope="col" className="numeric">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td className="muted">{formatDateTime(e.created_at)}</td>
                  <td>{ENTRY_KINDS[e.kind]}</td>
                  <td>
                    <Link to="/ledger/entries/$entryId" params={{ entryId: e.id }} className="num">
                      {e.reference}
                    </Link>
                  </td>
                  <td className="numeric num">{e.postings.length}</td>
                  <td className="numeric">
                    {entryTotals(e).map((m) => (
                      <div key={m.currency}>
                        <MoneyText value={m} />
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {entries.hasNextPage && (
            <button
              type="button"
              className="btn"
              onClick={() => void entries.fetchNextPage()}
              disabled={entries.isFetchingNextPage}
            >
              {entries.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          )}
        </section>
      )}
    </>
  );
}
