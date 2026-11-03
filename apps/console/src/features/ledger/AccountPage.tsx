import { Link } from '@tanstack/react-router';

import { MoneyText } from '@/components/MoneyText';
import { EmptyState, ErrorState, Skeleton } from '@/components/PageState';
import { formatDateTime } from '@/lib/dates';

import { useAccountIndex, usePostings } from './useLedger';

/** One ledger account's postings, newest first, with the running balance after each. */
export function AccountPage({ accountId }: { accountId: string }) {
  const index = useAccountIndex();
  const postings = usePostings(accountId);
  const account = index.data?.get(accountId);
  const rows = postings.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <>
      <div className="stack tight">
        <Link to="/ledger/accounts" search={{}} className="back-link">
          ← Accounts
        </Link>
        <h1>{account?.name ?? 'Ledger account'}</h1>
        {account && (
          <p className="row">
            <span className="num muted">{account.kind}</span>
            <span className="muted">·</span>
            <span>
              Balance <MoneyText value={account.balance} className="strong" />
            </span>
            {account.owner_id && (
              <Link to="/customers/$userId" params={{ userId: account.owner_id }}>
                Customer 360
              </Link>
            )}
          </p>
        )}
      </div>

      {postings.isPending ? (
        <div className="card stack" aria-busy="true" aria-label="Loading postings">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} height={24} />
          ))}
        </div>
      ) : postings.isError ? (
        <ErrorState error={postings.error} onRetry={() => void postings.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No postings">Nothing has moved through this account yet.</EmptyState>
      ) : (
        <section className="card stack" aria-label="Postings">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Posted</th>
                <th scope="col">Entry</th>
                <th scope="col" className="numeric">
                  Amount
                </th>
                <th scope="col" className="numeric">
                  Balance after
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td className="muted">{formatDateTime(p.created_at)}</td>
                  <td>
                    <Link to="/ledger/entries/$entryId" params={{ entryId: p.entry_id }}>
                      View entry
                    </Link>
                  </td>
                  <td className="numeric">
                    <MoneyText value={p.amount} />
                  </td>
                  <td className="numeric muted">
                    {p.balance_after ? <MoneyText value={p.balance_after} /> : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {postings.hasNextPage && (
            <button
              type="button"
              className="btn"
              onClick={() => void postings.fetchNextPage()}
              disabled={postings.isFetchingNextPage}
            >
              {postings.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          )}
        </section>
      )}
    </>
  );
}
