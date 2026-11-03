import { Link, useNavigate } from '@tanstack/react-router';

import { Badge } from '@/components/Badge';
import { MoneyText } from '@/components/MoneyText';
import { EmptyState, ErrorState, Skeleton } from '@/components/PageState';
import { Segmented } from '@/components/Segmented';
import { formatDateTime } from '@/lib/dates';

import { DISPUTE_STATUS, FILTERS, REASONS } from './labels';
import { useDisputeQueue, type DisputeFilter } from './useDisputes';

export function DisputeQueuePage({ filter }: { filter: DisputeFilter }) {
  const navigate = useNavigate();
  const queue = useDisputeQueue(filter);
  const rows = queue.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <>
      <div className="row space-between">
        <div className="stack tight">
          <h1>Disputes</h1>
          <p className="muted">Customer disputes, longest waiting first.</p>
        </div>
        <Segmented
          label="Show disputes"
          options={FILTERS}
          value={filter}
          onChange={(next) => void navigate({ to: '/disputes', search: { status: next } })}
        />
      </div>

      {queue.isPending ? (
        <div className="card stack" aria-busy="true" aria-label="Loading disputes">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} height={24} />
          ))}
        </div>
      ) : queue.isError ? (
        <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={filter === 'active' ? 'No open disputes' : 'Nothing here'}>
          {filter === 'active'
            ? 'Every dispute has an answer. New ones appear here when a customer raises one.'
            : 'No disputes have this outcome yet.'}
        </EmptyState>
      ) : (
        <section className="card stack" aria-label="Disputes" aria-busy={queue.isFetching}>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Case</th>
                <th scope="col">Customer</th>
                <th scope="col">Reason</th>
                <th scope="col" className="numeric">
                  Amount
                </th>
                <th scope="col">Merchant or recipient</th>
                <th scope="col">Status</th>
                <th scope="col">Raised</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ dispute, customer, transaction, assignee }) => {
                const [label, tone] = DISPUTE_STATUS[dispute.status];
                return (
                  <tr key={dispute.id}>
                    <td>
                      <Link
                        to="/disputes/$disputeId"
                        params={{ disputeId: dispute.id }}
                        className="num"
                      >
                        {dispute.case_number}
                      </Link>
                    </td>
                    <td>{customer.name}</td>
                    <td>{REASONS[dispute.reason]}</td>
                    <td className="numeric">
                      <MoneyText value={transaction.amount} />
                    </td>
                    <td className="muted">{transaction.counterparty.name}</td>
                    <td>
                      <Badge tone={tone}>{label}</Badge>
                      {assignee && <span className="muted hint"> {assignee.name}</span>}
                    </td>
                    <td className="muted">{formatDateTime(dispute.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {queue.hasNextPage && (
            <button
              type="button"
              className="btn"
              onClick={() => void queue.fetchNextPage()}
              disabled={queue.isFetchingNextPage}
            >
              {queue.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          )}
        </section>
      )}
    </>
  );
}
