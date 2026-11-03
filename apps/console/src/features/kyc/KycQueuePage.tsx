import { Link, useNavigate } from '@tanstack/react-router';

import { Badge } from '@/components/Badge';
import { EmptyState, ErrorState, Skeleton } from '@/components/PageState';
import { Segmented } from '@/components/Segmented';
import { formatDateTime } from '@/lib/dates';

import { OVERDUE_HOURS, QUEUE_STATUSES, SUBMISSION_STATUS, formatWaiting } from './labels';
import { useKycQueue, type KycQueueStatus } from './useKyc';

const FILTERS = QUEUE_STATUSES.map((s) => ({ value: s.status, label: s.label }));

export function KycQueuePage({ status }: { status: KycQueueStatus }) {
  const navigate = useNavigate();
  const queue = useKycQueue(status);
  const rows = queue.data?.pages.flatMap((p) => p.data) ?? [];
  const waiting = status === 'pending_review';

  return (
    <>
      <div className="row space-between">
        <div className="stack tight">
          <h1>KYC reviews</h1>
          <p className="muted">Oldest first, so nobody waits too long.</p>
        </div>
        <Segmented
          label="Show submissions"
          options={FILTERS}
          value={status}
          onChange={(next) => void navigate({ to: '/kyc', search: { status: next } })}
        />
      </div>

      {queue.isPending ? (
        <div className="card stack" aria-busy="true" aria-label="Loading submissions">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} height={24} />
          ))}
        </div>
      ) : queue.isError ? (
        <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={waiting ? 'Queue clear' : 'Nothing here'}>
          {waiting
            ? 'No submissions are waiting. New ones appear here as customers upgrade.'
            : 'No submissions have this status yet.'}
        </EmptyState>
      ) : (
        <section className="card stack" aria-label="Submissions" aria-busy={queue.isFetching}>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col">Upgrade</th>
                <th scope="col">Submitted</th>
                <th scope="col">{waiting ? 'Waiting' : 'Decided after'}</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ submission, customer, waiting_hours }) => {
                const [label, tone] = SUBMISSION_STATUS[submission.status];
                const overdue = waiting && waiting_hours >= OVERDUE_HOURS;
                return (
                  <tr key={submission.id}>
                    <td>
                      <Link to="/kyc/$submissionId" params={{ submissionId: submission.id }}>
                        {customer.name}
                      </Link>
                    </td>
                    <td>
                      Tier {customer.kyc_tier} → {submission.target_tier}
                    </td>
                    <td className="muted">{formatDateTime(submission.submitted_at)}</td>
                    <td>
                      <span className="num">{formatWaiting(waiting_hours)}</span>
                      {overdue && (
                        <>
                          {' '}
                          <Badge tone="danger">Over a day</Badge>
                        </>
                      )}
                    </td>
                    <td>
                      <Badge tone={tone}>{label}</Badge>
                    </td>
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
