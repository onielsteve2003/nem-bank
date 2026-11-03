import { Link } from '@tanstack/react-router';

import { Badge } from '@/components/Badge';
import { MoneyText } from '@/components/MoneyText';
import { ErrorState, Skeleton } from '@/components/PageState';
import { useSession } from '@/features/auth/session';
import { isApiError } from '@/data/errors';
import { formatDateTime } from '@/lib/dates';

import { FraudDecisionForm } from './FraudDecisionForm';
import { CASE_STATUS, LABELS, SEVERITY, formatAge, scoreOutOf100 } from './labels';
import { useAssignFraudCase, useFraudCase, type FraudCase } from './useFraud';

export function FraudCasePage({ caseId }: { caseId: string }) {
  const query = useFraudCase(caseId);
  const me = useSession((s) => s.session?.staff.id);

  if (query.isPending) {
    return (
      <div className="stack" aria-busy="true" aria-label="Loading case">
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

  const c = query.data;
  const { transfer } = c;
  const [statusLabel, statusTone] = CASE_STATUS[c.status];
  const closed = c.status === 'released' || c.status === 'rejected';
  const mine = c.assignee?.id === me;

  return (
    <>
      <div className="stack tight">
        <Link to="/fraud" search={{ status: 'active', mine: false }} className="back-link">
          ← Fraud cases
        </Link>
        <h1>
          <MoneyText value={transfer.amount} /> to {transfer.recipient.name}
        </h1>
        <p className="row">
          <Badge tone={statusTone}>{statusLabel}</Badge>
          <span className="muted">Held {formatDateTime(c.created_at)}</span>
          {c.assignee && <span className="muted">· {c.assignee.name} is on it</span>}
        </p>
      </div>

      <div className="review-grid">
        <div className="stack">
          <RiskPanel fraudCase={c} />
          <TransferPanel fraudCase={c} />
        </div>
        <div className="stack">
          <section className="card stack" aria-labelledby="fraud-customer-title">
            <h2 id="fraud-customer-title">Customer</h2>
            <p className="row">
              <Link to="/customers/$userId" params={{ userId: c.customer.user_id }}>
                {c.customer.name}
              </Link>
              <span className="muted">Tier {c.customer.kyc_tier}</span>
              {c.customer.status !== 'active' && <Badge tone="danger">{c.customer.status}</Badge>}
            </p>
          </section>
          {closed ? (
            <Outcome fraudCase={c} />
          ) : mine ? (
            <FraudDecisionForm caseId={c.id} />
          ) : (
            <TakeCase caseId={c.id} assignee={c.assignee?.name ?? null} />
          )}
        </div>
      </div>
    </>
  );
}

function RiskPanel({ fraudCase: c }: { fraudCase: FraudCase }) {
  const score = scoreOutOf100(c.risk.score);
  const signals = c.signals;
  return (
    <section className="card stack" aria-labelledby="risk-title">
      <div className="row space-between">
        <h2 id="risk-title">Why it was held</h2>
        <span className="muted hint">Model {c.risk.model_version}</span>
      </div>
      <div className="score">
        <span className="num stat-value">{score}</span>
        <span className="muted">/ 100 risk</span>
        <meter
          className="score-meter"
          min={0}
          max={100}
          low={60}
          high={80}
          optimum={0}
          value={score}
          aria-label={`Risk score ${score} out of 100`}
        />
      </div>
      <ul className="note-list">
        {c.risk.reasons.map((r) => (
          <li key={r.code}>
            <p className="row">
              <Badge tone={SEVERITY[r.severity]}>{r.severity}</Badge>
              {r.message}
            </p>
            <span className="muted hint num">{r.code}</span>
          </li>
        ))}
      </ul>
      {signals && (
        <dl className="facts">
          <dt>Device age</dt>
          <dd>{formatAge(signals.device_age_hours)}</dd>
          <dt>Recipient known for</dt>
          <dd>
            {signals.beneficiary_age_hours === 0
              ? 'First transfer'
              : formatAge(signals.beneficiary_age_hours)}
          </dd>
          <dt>Transfers in 24 h</dt>
          <dd className="num">{signals.transfers_last_24h ?? '—'}</dd>
          <dt>Usual transfer</dt>
          <dd>{signals.average_transfer ? <MoneyText value={signals.average_transfer} /> : '—'}</dd>
        </dl>
      )}
    </section>
  );
}

function TransferPanel({ fraudCase: { transfer } }: { fraudCase: FraudCase }) {
  return (
    <section className="card stack" aria-labelledby="transfer-title">
      <h2 id="transfer-title">Transfer</h2>
      <dl className="facts">
        <dt>Recipient</dt>
        <dd>
          {transfer.recipient.name} · {transfer.recipient.bank_name}{' '}
          <span className="num muted">{transfer.recipient.account_number_masked}</span>
        </dd>
        <dt>Narration</dt>
        <dd>“{transfer.narration}”</dd>
        <dt>Amount + fee</dt>
        <dd>
          <MoneyText value={transfer.amount} /> + <MoneyText value={transfer.fee} /> ={' '}
          <MoneyText value={transfer.total_debit} />
        </dd>
        <dt>Reference</dt>
        <dd className="num">{transfer.reference}</dd>
      </dl>
      <ol className="note-list" aria-label="Timeline">
        {transfer.timeline.map((e) => (
          <li key={`${e.status}-${e.at}`}>
            <p>{e.label}</p>
            <span className="muted hint">
              {formatDateTime(e.at)}
              {e.detail && ` · ${e.detail}`}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function TakeCase({ caseId, assignee }: { caseId: string; assignee: string | null }) {
  const assign = useAssignFraudCase(caseId);
  return (
    <section className="card stack" aria-labelledby="take-title">
      <h2 id="take-title">{assignee ? `${assignee} has this case` : 'Nobody has this case yet'}</h2>
      <p className="muted">
        {assignee
          ? 'Only the assigned reviewer can release or reject it.'
          : 'Take it so nobody else works on it at the same time.'}
      </p>
      {assign.isError && (
        <p className="field-error" role="alert">
          {isApiError(assign.error) ? assign.error.message : 'Could not take the case.'}
        </p>
      )}
      {!assignee && (
        <div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => assign.mutate()}
            disabled={assign.isPending}
          >
            {assign.isPending ? 'Taking…' : 'Take case'}
          </button>
        </div>
      )}
    </section>
  );
}

function Outcome({ fraudCase: c }: { fraudCase: FraudCase }) {
  const label = LABELS.find((l) => l.value === c.label);
  return (
    <section className="card stack" role="status" aria-labelledby="outcome-title">
      <h2 id="outcome-title">{c.status === 'released' ? 'Released' : 'Rejected'}</h2>
      <p className="muted">
        {c.assignee?.name ?? 'A reviewer'} closed this
        {c.closed_at && ` on ${formatDateTime(c.closed_at)}`}.
      </p>
      {label && (
        <p className="row">
          Label <Badge tone={c.label === 'fraud' ? 'danger' : 'neutral'}>{label.label}</Badge>
          <span className="muted hint">Sent to the next model retraining.</span>
        </p>
      )}
      {c.note && <p>“{c.note}”</p>}
    </section>
  );
}
