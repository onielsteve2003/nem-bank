import { Link } from '@tanstack/react-router';

import { Badge } from '@/components/Badge';
import { ErrorState, Skeleton } from '@/components/PageState';
import { formatDateTime } from '@/lib/dates';

import { DocumentViewer } from './DocumentViewer';
import { KycDecisionForm } from './KycDecisionForm';
import { DOCUMENT_LABELS, NAME_MATCH, SUBMISSION_STATUS } from './labels';
import { useKycReview } from './useKyc';

export function KycReviewPage({ submissionId }: { submissionId: string }) {
  const query = useKycReview(submissionId);

  if (query.isPending) {
    return (
      <div className="stack" aria-busy="true" aria-label="Loading submission">
        <Skeleton height={36} width={280} />
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

  const { submission, customer, documents, identity_checks, address, reviewer } = query.data;
  const [statusLabel, statusTone] = SUBMISSION_STATUS[submission.status];
  const pending = submission.status === 'pending_review';

  return (
    <>
      <div className="stack tight">
        <Link to="/kyc" search={{ status: 'pending_review' }} className="back-link">
          ← KYC reviews
        </Link>
        <h1>{customer.name}</h1>
        <p className="row">
          <span>
            Tier {customer.kyc_tier} → {submission.target_tier}
          </span>
          <Badge tone={statusTone}>{statusLabel}</Badge>
          <span className="muted">Submitted {formatDateTime(submission.submitted_at)}</span>
          <Link to="/customers/$userId" params={{ userId: customer.user_id }}>
            Open customer 360
          </Link>
        </p>
      </div>

      <div className="review-grid">
        <DocumentViewer documents={documents} />
        <div className="stack">
          <section className="card stack" aria-labelledby="checks-title">
            <h2 id="checks-title">Identity checks</h2>
            <ul className="note-list">
              {identity_checks.map((c) => {
                const [matchLabel, matchTone] = NAME_MATCH[c.name_match.result];
                return (
                  <li key={c.type}>
                    <p className="row">
                      <strong>{c.type.toUpperCase()}</strong>
                      <Badge tone={c.verified ? 'success' : 'danger'}>
                        {c.verified ? '✓ Verified' : '✕ Not verified'}
                      </Badge>
                      <Badge tone={matchTone}>
                        {matchLabel} · {Math.round(c.name_match.confidence * 100)}%
                      </Badge>
                      {c.sandbox && <Badge>Sandbox</Badge>}
                    </p>
                    {c.name_match.expected_name && (
                      <span className="muted hint">On record: {c.name_match.expected_name}</span>
                    )}
                    {c.date_of_birth_match !== undefined && (
                      <span className="muted hint">
                        Date of birth {c.date_of_birth_match ? 'matches' : 'does not match'}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            <dl className="facts">
              <dt>ID type</dt>
              <dd>{query.data.id_type}</dd>
              <dt>ID number</dt>
              <dd className="num">{query.data.id_number_masked}</dd>
              <dt>Address</dt>
              <dd>
                {[address.line1, address.line2, address.city, address.state, address.country]
                  .filter(Boolean)
                  .join(', ')}
              </dd>
            </dl>
          </section>

          {pending ? (
            <KycDecisionForm
              submissionId={submission.id}
              documents={documents.map((d) => d.kind)}
            />
          ) : (
            <section className="card stack" role="status" aria-labelledby="decided-title">
              <h2 id="decided-title">{statusLabel}</h2>
              <p className="muted">
                {reviewer?.name ?? 'A reviewer'} decided this
                {submission.reviewed_at && ` on ${formatDateTime(submission.reviewed_at)}`}.
              </p>
              {submission.rejection_reason && (
                <p>Told the customer: “{submission.rejection_reason}”</p>
              )}
              {submission.resubmit_documents && submission.resubmit_documents.length > 0 && (
                <p className="muted">
                  To upload again:{' '}
                  {submission.resubmit_documents.map((k) => DOCUMENT_LABELS[k]).join(', ')}
                </p>
              )}
            </section>
          )}
        </div>
      </div>
    </>
  );
}
