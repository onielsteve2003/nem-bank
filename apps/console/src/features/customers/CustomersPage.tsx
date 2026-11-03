import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';

import { Badge } from '@/components/Badge';
import { EmptyState, ErrorState, Skeleton } from '@/components/PageState';
import { formatDateTime } from '@/lib/dates';

import { STATUS_LABELS, STATUS_TONE } from './labels';
import { useCustomerSearch } from './useCustomers';

export function CustomersPage({ q }: { q: string }) {
  const navigate = useNavigate();
  const [text, setText] = useState(q);
  const search = useCustomerSearch(q);
  const rows = search.data?.pages.flatMap((p) => p.data) ?? [];
  const tooShort = text.trim().length < 2;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!tooShort) void navigate({ to: '/customers', search: { q: text.trim() } });
  };

  return (
    <>
      <div className="stack tight">
        <h1>Customers</h1>
        <p className="muted">
          Search by name, email, phone, @nemtag or account number. Every search is audit-logged.
        </p>
      </div>
      <form className="row search-form" role="search" onSubmit={onSubmit}>
        <label className="field grow">
          <span className="sr-only">Search customers</span>
          <input
            className="input"
            type="search"
            placeholder="e.g. Adaeze, @tolu, 0803 123 4821"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={tooShort}>
          Search
        </button>
      </form>

      {q.length < 2 ? (
        <EmptyState title="Find a customer">
          Try a name like Adaeze or Emeka, a tag like @ngozie, or the last digits of a phone.
        </EmptyState>
      ) : search.isPending ? (
        <div className="card stack" aria-busy="true" aria-label="Searching">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} height={24} />
          ))}
        </div>
      ) : search.isError ? (
        <ErrorState error={search.error} onRetry={() => void search.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={`No customers match “${q}”`}>
          Check the spelling, or search by phone or account number instead.
        </EmptyState>
      ) : (
        <section className="card stack" aria-label="Search results">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Contact</th>
                <th scope="col">KYC</th>
                <th scope="col">Status</th>
                <th scope="col">Joined</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.user_id}>
                  <td>
                    <Link to="/customers/$userId" params={{ userId: c.user_id }}>
                      {c.name}
                    </Link>
                    {c.nemtag && <span className="muted"> @{c.nemtag}</span>}
                  </td>
                  <td className="muted">
                    {c.email_masked}
                    <br />
                    {c.phone_masked}
                  </td>
                  <td>Tier {c.kyc_tier}</td>
                  <td>
                    <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABELS[c.status]}</Badge>
                  </td>
                  <td className="muted">{formatDateTime(c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {search.hasNextPage && (
            <button
              type="button"
              className="btn"
              onClick={() => void search.fetchNextPage()}
              disabled={search.isFetchingNextPage}
            >
              {search.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          )}
        </section>
      )}
    </>
  );
}
