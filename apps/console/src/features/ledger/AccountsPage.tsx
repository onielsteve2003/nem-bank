import type { CurrencyCode } from '@nem/contracts';
import { Link, useNavigate } from '@tanstack/react-router';

import { Badge } from '@/components/Badge';
import { MoneyText } from '@/components/MoneyText';
import { EmptyState, ErrorState, Skeleton } from '@/components/PageState';
import { Segmented } from '@/components/Segmented';

import { LedgerTabs } from './LedgerTabs';
import { useLedgerAccounts, type AccountFilters } from './useLedger';

type Owner = 'all' | 'system' | 'customer';
const OWNERS: readonly { value: Owner; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'system', label: 'Bank' },
  { value: 'customer', label: 'Customers' },
];
const CURRENCIES: readonly CurrencyCode[] = ['NGN', 'USD'];

export function AccountsPage({ filters }: { filters: AccountFilters }) {
  const navigate = useNavigate();
  const accounts = useLedgerAccounts(filters);
  const rows = accounts.data?.pages.flatMap((p) => p.data) ?? [];
  const apply = (next: AccountFilters) =>
    void navigate({ to: '/ledger/accounts', search: { ...filters, ...next } });

  return (
    <>
      <div className="stack tight">
        <h1>Ledger</h1>
        <p className="muted">
          Customer accounts and the bank’s own: fees, FX positions, settlement and suspense.
        </p>
      </div>
      <LedgerTabs />

      <div className="row filters">
        <Segmented
          label="Owner"
          options={OWNERS}
          value={filters.owner ?? 'all'}
          onChange={(o) => apply({ owner: o === 'all' ? undefined : o })}
        />
        <label className="field">
          <span className="sr-only">Currency</span>
          <select
            className="select"
            value={filters.currency ?? ''}
            onChange={(e) =>
              apply({ currency: (e.target.value || undefined) as CurrencyCode | undefined })
            }
          >
            <option value="">All currencies</option>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </div>

      {accounts.isPending ? (
        <div className="card stack" aria-busy="true" aria-label="Loading accounts">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} height={24} />
          ))}
        </div>
      ) : accounts.isError ? (
        <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No accounts">Nothing matches these filters.</EmptyState>
      ) : (
        <section
          className="card stack"
          aria-label="Ledger accounts"
          aria-busy={accounts.isFetching}
        >
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Kind</th>
                <th scope="col">Owner</th>
                <th scope="col" className="numeric">
                  Balance
                </th>
                <th scope="col" className="numeric">
                  Postings
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link to="/ledger/accounts/$accountId" params={{ accountId: a.id }}>
                      {a.name ?? a.id}
                    </Link>
                  </td>
                  <td className="num muted">{a.kind}</td>
                  <td>
                    {a.owner_id ? (
                      <Link to="/customers/$userId" params={{ userId: a.owner_id }}>
                        Customer 360
                      </Link>
                    ) : (
                      <Badge>Bank</Badge>
                    )}
                  </td>
                  <td className="numeric">
                    <MoneyText value={a.balance} />
                  </td>
                  <td className="numeric num muted">{a.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {accounts.hasNextPage && (
            <button
              type="button"
              className="btn"
              onClick={() => void accounts.fetchNextPage()}
              disabled={accounts.isFetchingNextPage}
            >
              {accounts.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          )}
        </section>
      )}
    </>
  );
}
