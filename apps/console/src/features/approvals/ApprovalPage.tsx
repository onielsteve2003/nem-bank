import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { Badge } from '@/components/Badge';
import { ErrorState, Skeleton } from '@/components/PageState';
import { ReasonForm } from '@/components/ReasonForm';
import { isApiError } from '@/data/errors';
import { useSession } from '@/features/auth/session';
import { formatDateTime } from '@/lib/dates';

import { ChangeDiff } from './ChangeDiff';
import { ACTIONS, STATUS } from './labels';
import { useApproval, useApprove, useReject, type ApprovalRequest } from './useApprovals';

function Decision({ approval }: { approval: ApprovalRequest }) {
  const approve = useApprove(approval.id);
  const reject = useReject(approval.id);
  const [rejecting, setRejecting] = useState(false);
  // One key per page visit: a double click or a retried request approves once.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  if (rejecting) {
    return (
      <ReasonForm
        title="Reject this request?"
        description="Nothing changes. The maker sees your reason."
        submitLabel="Reject"
        danger
        pending={reject.isPending}
        error={reject.error}
        onCancel={() => setRejecting(false)}
        onSubmit={(reason) => reject.mutate(reason)}
      />
    );
  }

  return (
    <section className="card stack action-form" aria-labelledby="decide-title">
      <h2 id="decide-title">Your decision</h2>
      <p className="muted">
        Approving applies the change at once and records you as the checker in the audit log.
      </p>
      {approve.error != null && (
        <p className="field-error" role="alert">
          {isApiError(approve.error) ? approve.error.message : 'Something went wrong. Try again.'}
          {isApiError(approve.error) && approve.error.problem.detail && (
            <span className="muted"> {approve.error.problem.detail}</span>
          )}
        </p>
      )}
      <div className="row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={approve.isPending}
          onClick={() => approve.mutate(idempotencyKey)}
        >
          {approve.isPending ? 'Approving…' : 'Approve and apply'}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={approve.isPending}
          onClick={() => setRejecting(true)}
        >
          Reject
        </button>
      </div>
    </section>
  );
}

export function ApprovalPage({ approvalId }: { approvalId: string }) {
  const query = useApproval(approvalId);
  const me = useSession((s) => s.session?.staff.id);

  if (query.isPending) {
    return (
      <div className="stack" aria-busy="true" aria-label="Loading request">
        <Skeleton height={36} width={320} />
        <Skeleton height={240} />
      </div>
    );
  }
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const a = query.data;
  const [statusLabel, tone] = STATUS[a.status];
  const mine = a.maker.id === me;

  return (
    <>
      <div className="stack tight">
        <Link to="/approvals" search={{ status: 'pending' }} className="back-link">
          ← Approvals
        </Link>
        <h1>{a.summary}</h1>
        <p className="row">
          <Badge tone={tone}>{statusLabel}</Badge>
          <Badge tone="info">{ACTIONS[a.action]}</Badge>
        </p>
      </div>

      <div className="review-grid">
        <section className="card stack" aria-labelledby="request-title">
          <h2 id="request-title">Request</h2>
          <dl className="facts">
            <dt>Maker</dt>
            <dd>
              {a.maker.name}
              {mine && ' (you)'}
            </dd>
            <dt>Reason</dt>
            <dd>{a.reason}</dd>
            <dt>Raised</dt>
            <dd>{formatDateTime(a.created_at)}</dd>
            {a.status === 'pending' ? (
              <>
                <dt>Expires</dt>
                <dd>{formatDateTime(a.expires_at)}</dd>
              </>
            ) : (
              <>
                <dt>Checker</dt>
                <dd>{a.checker?.name ?? '—'}</dd>
                <dt>Decided</dt>
                <dd>{a.decided_at ? formatDateTime(a.decided_at) : '—'}</dd>
              </>
            )}
            {a.rejection_reason && (
              <>
                <dt>Why it was rejected</dt>
                <dd>{a.rejection_reason}</dd>
              </>
            )}
          </dl>
        </section>

        <div className="stack">
          {a.status === 'pending' &&
            (mine ? (
              <section className="card stack" role="note" aria-label="Maker-checker">
                <h2>Waiting for someone else</h2>
                <p className="muted">
                  You made this request, so a different staff member has to approve or reject it.
                  Switch role from the staff menu to try it as another person.
                </p>
              </section>
            ) : (
              <Decision approval={a} />
            ))}
          <ChangeDiff before={a.before} after={a.after} />
        </div>
      </div>
    </>
  );
}
