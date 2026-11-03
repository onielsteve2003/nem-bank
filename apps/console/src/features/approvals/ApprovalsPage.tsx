import { Link, useNavigate } from '@tanstack/react-router';

import { Badge } from '@/components/Badge';
import { EmptyState, ErrorState, Skeleton } from '@/components/PageState';
import { Segmented } from '@/components/Segmented';
import { useSession } from '@/features/auth/session';
import { formatDateTime } from '@/lib/dates';

import { ACTIONS, FILTERS, STATUS } from './labels';
import { useApprovals, type ApprovalStatus } from './useApprovals';

export function ApprovalsPage({ status }: { status: ApprovalStatus }) {
  const navigate = useNavigate();
  const me = useSession((s) => s.session?.staff.id);
  const list = useApprovals(status);
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const pending = status === 'pending';

  return (
    <>
      <div className="row space-between">
        <div className="stack tight">
          <h1>Approvals</h1>
          <p className="muted">
            Sensitive changes one person proposes and a second approves (maker-checker).
          </p>
        </div>
        <Segmented
          label="Show requests"
          options={FILTERS}
          value={status}
          onChange={(next) => void navigate({ to: '/approvals', search: { status: next } })}
        />
      </div>

      {list.isPending ? (
        <div className="card stack" aria-busy="true" aria-label="Loading approvals">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} height={24} />
          ))}
        </div>
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={pending ? 'Nothing waiting' : 'Nothing here'}>
          {pending
            ? 'Unfreezes, large refunds and configuration changes appear here for a second person.'
            : `No requests are ${STATUS[status][0].toLowerCase()} yet.`}
        </EmptyState>
      ) : (
        <section className="card stack" aria-label="Approval requests" aria-busy={list.isFetching}>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Request</th>
                <th scope="col">Type</th>
                <th scope="col">Maker</th>
                <th scope="col">{pending ? 'Raised' : 'Checker'}</th>
                <th scope="col">{pending ? 'Expires' : 'Decided'}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link to="/approvals/$approvalId" params={{ approvalId: a.id }}>
                      {a.summary}
                    </Link>
                  </td>
                  <td>
                    <Badge tone="info">{ACTIONS[a.action]}</Badge>
                  </td>
                  <td>
                    {a.maker.name}
                    {a.maker.id === me && <span className="muted hint"> (you)</span>}
                  </td>
                  <td className="muted">
                    {pending ? formatDateTime(a.created_at) : (a.checker?.name ?? '—')}
                  </td>
                  <td className="muted">
                    {formatDateTime(pending ? a.expires_at : (a.decided_at ?? a.expires_at))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.hasNextPage && (
            <button
              type="button"
              className="btn"
              onClick={() => void list.fetchNextPage()}
              disabled={list.isFetchingNextPage}
            >
              {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          )}
        </section>
      )}
    </>
  );
}
