import type { CurrencyCode } from '@nem/contracts';
import { Link } from '@tanstack/react-router';

import { Badge } from '@/components/Badge';
import { MoneyText } from '@/components/MoneyText';
import { ErrorState, Skeleton } from '@/components/PageState';
import { formatDateTime } from '@/lib/dates';

import { ENTRY_KINDS } from './labels';
import { useAccountIndex, useJournalEntry, type JournalEntry } from './useLedger';

const abs = (amount: bigint) => (amount < 0n ? -amount : amount);
const money = (amount: bigint, currency: CurrencyCode) => ({
  amount_minor: amount.toString(),
  currency,
});

/** Debits and credits per currency: the proof this entry balances. */
function totals(entry: JournalEntry) {
  const byCurrency = new Map<CurrencyCode, { debits: bigint; credits: bigint }>();
  for (const p of entry.postings) {
    const amount = BigInt(p.amount.amount_minor);
    const t = byCurrency.get(p.amount.currency) ?? { debits: 0n, credits: 0n };
    if (amount < 0n) t.debits -= amount;
    else t.credits += amount;
    byCurrency.set(p.amount.currency, t);
  }
  return [...byCurrency];
}

export function EntryPage({ entryId }: { entryId: string }) {
  const query = useJournalEntry(entryId);
  const index = useAccountIndex();

  if (query.isPending) {
    return (
      <div className="stack" aria-busy="true" aria-label="Loading entry">
        <Skeleton height={36} width={320} />
        <Skeleton height={240} />
      </div>
    );
  }
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const entry = query.data;
  const metadata = Object.entries(entry.metadata);

  return (
    <>
      <div className="stack tight">
        <Link to="/ledger" search={{}} className="back-link">
          ← Journal
        </Link>
        <h1 className="num">{entry.reference}</h1>
        <p className="row">
          <Badge tone="info">{ENTRY_KINDS[entry.kind]}</Badge>
          <span className="muted">Posted {formatDateTime(entry.created_at)}</span>
        </p>
      </div>

      <section className="card stack" aria-labelledby="postings-title">
        <h2 id="postings-title">Postings</h2>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col" className="numeric">
                Debit
              </th>
              <th scope="col" className="numeric">
                Credit
              </th>
              <th scope="col" className="numeric">
                Balance after
              </th>
            </tr>
          </thead>
          <tbody>
            {entry.postings.map((p) => {
              const amount = BigInt(p.amount.amount_minor);
              const account = index.data?.get(p.account_id);
              return (
                <tr key={p.id}>
                  <td>
                    <Link to="/ledger/accounts/$accountId" params={{ accountId: p.account_id }}>
                      {account?.name ?? p.account_id}
                    </Link>
                  </td>
                  <td className="numeric">
                    {amount < 0n && <MoneyText value={money(abs(amount), p.amount.currency)} />}
                  </td>
                  <td className="numeric">{amount > 0n && <MoneyText value={p.amount} />}</td>
                  <td className="numeric muted">
                    {p.balance_after ? <MoneyText value={p.balance_after} /> : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            {totals(entry).map(([currency, t]) => (
              <tr key={currency}>
                <th scope="row">
                  {currency} total{' '}
                  <Badge tone={t.debits === t.credits ? 'success' : 'danger'}>
                    {t.debits === t.credits ? 'Balanced' : 'Unbalanced'}
                  </Badge>
                </th>
                <td className="numeric strong">
                  <MoneyText value={money(t.debits, currency)} />
                </td>
                <td className="numeric strong">
                  <MoneyText value={money(t.credits, currency)} />
                </td>
                <td />
              </tr>
            ))}
          </tfoot>
        </table>
      </section>

      <section className="card stack" aria-labelledby="entry-meta-title">
        <h2 id="entry-meta-title">Details</h2>
        <dl className="facts">
          <dt>Entry ID</dt>
          <dd className="num">{entry.id}</dd>
          <dt>Idempotency key</dt>
          <dd className="num">{entry.idempotency_key ?? '—'}</dd>
          {entry.approval_id && (
            <>
              <dt>Approval</dt>
              <dd className="num">{entry.approval_id}</dd>
            </>
          )}
          {metadata.map(([key, value]) => (
            <div key={key} className="contents">
              <dt>{key}</dt>
              <dd className="num">{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}
