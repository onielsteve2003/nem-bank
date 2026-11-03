import { Link, useNavigate } from '@tanstack/react-router';

import { Badge } from '@/components/Badge';
import { MoneyText } from '@/components/MoneyText';
import { EmptyState, ErrorState, Skeleton } from '@/components/PageState';
import { Segmented } from '@/components/Segmented';
import { formatDateTime } from '@/lib/dates';

import { CASE_STATUS, FILTERS, scoreOutOf100, scoreTone } from './labels';
import { useFraudQueue, type FraudFilter } from './useFraud';

type Props = { filter: FraudFilter; mine: boolean };

export function FraudQueuePage({ filter, mine }: Props) {
  const navigate = useNavigate();
  const queue = useFraudQueue(filter, mine);
  const rows = queue.data?.pages.flatMap((p) => p.data) ?? [];
  const go = (next: { status?: FraudFilter; mine?: boolean }) =>
    void navigate({ to: '/fraud', search: { status: filter, mine, ...next } });

  return (
    <>
      <div className="row space-between">
        <div className="stack tight">
          <h1>Fraud cases</h1>
          <p className="muted">Transfers the risk engine held, highest score first.</p>
        </div>
        <div className="row">
          <label className="row checkbox-label">
            <input
              type="checkbox"
              checked={mine}
              onChange={(e) => go({ mine: e.target.checked })}
            />
            Only my cases
          </label>
          <Segmented
            label="Show cases"
            options={FILTERS}
            value={filter}
            onChange={(next) => go({ status: next })}
          />
        </div>
      </div>

      {queue.isPending ? (
        <div className="card stack" aria-busy="true" aria-label="Loading cases">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} height={24} />
          ))}
        </div>
      ) : queue.isError ? (
        <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={filter === 'active' ? 'No held transfers' : 'Nothing here'}>
          {filter === 'active'
            ? 'Nothing is waiting. Held transfers appear here the moment the engine stops one.'
            : 'No cases have this outcome yet.'}
        </EmptyState>
      ) : (
        <section className="card stack" aria-label="Cases" aria-busy={queue.isFetching}>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Score</th>
                <th scope="col">Customer</th>
                <th scope="col" className="numeric">
                  Amount
                </th>
                <th scope="col">To</th>
                <th scope="col">Top reason</th>
                <th scope="col">Status</th>
                <th scope="col">Held</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const [label, tone] = CASE_STATUS[c.status];
                return (
                  <tr key={c.id}>
                    <td>
                      <Badge tone={scoreTone(c.risk.score)}>
                        <span className="num">{scoreOutOf100(c.risk.score)}</span>
                      </Badge>
                    </td>
                    <td>
                      <Link to="/fraud/$caseId" params={{ caseId: c.id }}>
                        {c.customer.name}
                      </Link>
                    </td>
                    <td className="numeric">
                      <MoneyText value={c.transfer.amount} />
                    </td>
                    <td>
                      {c.transfer.recipient.name}
                      <span className="muted"> · {c.transfer.recipient.bank_name}</span>
                    </td>
                    <td className="muted">{c.risk.reasons[0]?.message ?? '—'}</td>
                    <td>
                      <Badge tone={tone}>{label}</Badge>
                      {c.assignee && <span className="muted hint"> {c.assignee.name}</span>}
                    </td>
                    <td className="muted">{formatDateTime(c.created_at)}</td>
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
