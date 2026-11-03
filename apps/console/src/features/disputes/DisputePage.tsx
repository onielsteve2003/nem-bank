import { Link } from '@tanstack/react-router';

import { Badge } from '@/components/Badge';
import { MoneyText } from '@/components/MoneyText';
import { ErrorState, Skeleton } from '@/components/PageState';
import { canCall } from '@/features/auth/access';
import { useSession } from '@/features/auth/session';
import { formatDateTime } from '@/lib/dates';

import { DisputeDecisionForm } from './DisputeDecisionForm';
import { DISPUTE_STATUS, REASONS } from './labels';
import { useDispute, type AdminDispute } from './useDisputes';

const CLOSED: readonly AdminDispute['dispute']['status'][] = [
  'resolved_refunded',
  'resolved_declined',
  'withdrawn',
];

export function DisputePage({ disputeId }: { disputeId: string }) {
  const query = useDispute(disputeId);
  const roles = useSession((s) => s.session?.staff.roles) ?? [];

  if (query.isPending) {
    return (
      <div className="stack" aria-busy="true" aria-label="Loading dispute">
        <Skeleton height={36} width={320} />
        <div className="review-grid">
          <Skeleton height={320} />
          <Skeleton height={320} />
        </div>
      </div>
    );
  }
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const d = query.data;
  const { dispute, transaction, customer } = d;
  const [statusLabel, statusTone] = DISPUTE_STATUS[dispute.status];
  const closed = CLOSED.includes(dispute.status);

  return (
    <>
      <div className="stack tight">
        <Link to="/disputes" search={{ status: 'active' }} className="back-link">
          ← Disputes
        </Link>
        <h1>
          <span className="num">{dispute.case_number}</span> · {REASONS[dispute.reason]}
        </h1>
        <p className="row">
          <Badge tone={statusTone}>{statusLabel}</Badge>
          <span className="muted">Raised {formatDateTime(dispute.created_at)}</span>
          {d.assignee && <span className="muted">· {d.assignee.name}</span>}
        </p>
      </div>

      <div className="review-grid">
        <div className="stack">
          <section className="card stack" aria-labelledby="claim-title">
            <h2 id="claim-title">The customer says</h2>
            <p>“{dispute.description}”</p>
            {dispute.evidence.length > 0 ? (
              <div className="evidence-grid">
                {dispute.evidence.map((file) => (
                  <figure key={file.id} className="evidence">
                    <a href={file.url} target="_blank" rel="noreferrer">
                      <img src={file.url} alt={`Evidence: ${file.file_name}`} />
                    </a>
                    <figcaption className="muted hint">
                      {file.file_name} · {Math.round(file.size_bytes / 1000)} KB
                    </figcaption>
                  </figure>
                ))}
              </div>
            ) : (
              <p className="muted hint">No evidence attached.</p>
            )}
          </section>

          <section className="card stack" aria-labelledby="dispute-tx-title">
            <h2 id="dispute-tx-title">Transaction</h2>
            <dl className="facts">
              <dt>Amount</dt>
              <dd>
                <MoneyText value={transaction.amount} />
              </dd>
              <dt>Merchant or recipient</dt>
              <dd>{transaction.counterparty.name}</dd>
              <dt>Paid</dt>
              <dd>{formatDateTime(transaction.created_at)}</dd>
              <dt>Reference</dt>
              <dd className="num">{transaction.reference}</dd>
              <dt>Journal entry</dt>
              <dd className="num muted">{transaction.journal_entry_id}</dd>
            </dl>
          </section>

          <section className="card stack" aria-labelledby="dispute-history-title">
            <h2 id="dispute-history-title">History</h2>
            <ol className="note-list">
              {dispute.timeline.map((e, i) => (
                <li key={`${e.status}-${e.at}-${i}`}>
                  <p>{e.label}</p>
                  <span className="muted hint">
                    {formatDateTime(e.at)}
                    {e.detail && ` · “${e.detail}”`}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <div className="stack">
          <section className="card stack" aria-labelledby="dispute-customer-title">
            <h2 id="dispute-customer-title">Customer</h2>
            <p className="row">
              <Link to="/customers/$userId" params={{ userId: customer.user_id }}>
                {customer.name}
              </Link>
              <span className="muted">Tier {customer.kyc_tier}</span>
              {customer.status !== 'active' && <Badge tone="danger">{customer.status}</Badge>}
            </p>
          </section>
          {closed ? (
            <section className="card stack" role="status" aria-labelledby="dispute-outcome-title">
              <h2 id="dispute-outcome-title">{statusLabel}</h2>
              {dispute.refund && (
                <p>
                  <MoneyText value={dispute.refund} /> back to the customer
                </p>
              )}
              {dispute.resolution_note && <p className="muted">“{dispute.resolution_note}”</p>}
              {dispute.resolved_at && (
                <p className="muted hint">Closed {formatDateTime(dispute.resolved_at)}</p>
              )}
            </section>
          ) : canCall(roles, 'decideDispute') ? (
            <DisputeDecisionForm dispute={d} />
          ) : (
            <section className="card stack" aria-labelledby="dispute-readonly-title">
              <h2 id="dispute-readonly-title">Compliance decides this</h2>
              <p className="muted">
                Support can read disputes and update the customer in chat. Refunds and declines need
                Compliance or Admin.
              </p>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
