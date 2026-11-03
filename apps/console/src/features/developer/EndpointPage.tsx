import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { Badge, type Tone } from '@/components/Badge';
import { EmptyState, ErrorState, Skeleton } from '@/components/PageState';
import { Segmented } from '@/components/Segmented';
import { isApiError } from '@/data/errors';
import { formatDateTime } from '@/lib/dates';

import { SecretOnce } from './SecretOnce';
import {
  useDeliveries,
  useEndpoint,
  useEndpointActions,
  type DeliveryStatus,
  type WebhookDelivery,
  type WebhookEndpoint,
} from './useDeveloper';

const STATUS: Readonly<Record<DeliveryStatus, [label: string, tone: Tone]>> = {
  pending: ['Pending', 'neutral'],
  succeeded: ['Delivered', 'success'],
  retrying: ['Retrying', 'warning'],
  failed: ['Failed', 'danger'],
};

const FILTERS: readonly { value: DeliveryStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'succeeded', label: 'Delivered' },
  { value: 'retrying', label: 'Retrying' },
  { value: 'failed', label: 'Failed' },
];

const VERIFY_SNIPPET = `// Node: check Nem-Signature before trusting a webhook
const [t, v1] = header.split(',').map((p) => p.split('=')[1]);
const expected = crypto
  .createHmac('sha256', process.env.NEM_WEBHOOK_SECRET)
  .update(\`\${t}.\${rawBody}\`)
  .digest('hex');
const fresh = Math.abs(Date.now() / 1000 - Number(t)) < 300;
const valid = fresh && crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected));`;

function errorText(error: unknown) {
  return isApiError(error) ? error.message : 'Something went wrong. Try again.';
}

function Actions({ endpoint }: { endpoint: WebhookEndpoint }) {
  const navigate = useNavigate();
  const actions = useEndpointActions(endpoint.id);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const off = endpoint.status === 'disabled';
  const error = [actions.test, actions.setStatus, actions.rotate, actions.remove].find(
    (m) => m.error != null,
  )?.error;

  return (
    <section className="card stack" aria-labelledby="actions-title">
      <h2 id="actions-title">Endpoint</h2>
      <dl className="facts">
        <dt>URL</dt>
        <dd className="num">{endpoint.url}</dd>
        <dt>Events</dt>
        <dd className="num">{endpoint.events.join(', ')}</dd>
        <dt>Signing secret</dt>
        <dd className="num">{endpoint.secret_prefix}…</dd>
        <dt>Failures in a row</dt>
        <dd>{endpoint.consecutive_failures}</dd>
      </dl>
      {actions.rotate.data && (
        <SecretOnce
          title="Your new signing secret"
          secret={actions.rotate.data.signing_secret}
          onDone={() => actions.rotate.reset()}
        />
      )}
      {actions.rotate.data && (
        <p className="muted hint">The old secret keeps signing alongside it for 24 hours.</p>
      )}
      {error != null && (
        <p className="field-error" role="alert">
          {errorText(error)}
        </p>
      )}
      {actions.test.data && (
        <p className="muted" role="status">
          Test event sent: {STATUS[actions.test.data.status][0].toLowerCase()} (HTTP{' '}
          {actions.test.data.response_status}).
        </p>
      )}
      <div className="row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={off || actions.test.isPending}
          onClick={() => actions.test.mutate()}
        >
          {actions.test.isPending ? 'Sending…' : 'Send test event'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={actions.setStatus.isPending}
          onClick={() => actions.setStatus.mutate(off ? 'active' : 'disabled')}
        >
          {off ? 'Turn on' : 'Turn off'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={actions.rotate.isPending}
          onClick={() => actions.rotate.mutate()}
        >
          Rotate secret
        </button>
        {confirmDelete ? (
          <>
            <button
              type="button"
              className="btn btn-danger"
              disabled={actions.remove.isPending}
              onClick={() =>
                actions.remove.mutate(undefined, {
                  onSuccess: () => void navigate({ to: '/developers/webhooks' }),
                })
              }
            >
              Yes, delete
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>
              Keep
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(true)}>
            Delete
          </button>
        )}
      </div>
    </section>
  );
}

function DeliveryRow({ delivery, endpointId }: { delivery: WebhookDelivery; endpointId: string }) {
  const { replay } = useEndpointActions(endpointId);
  const [open, setOpen] = useState(false);
  const [label, tone] = STATUS[delivery.status];
  const detailsId = `delivery-${delivery.id}`;

  return (
    <>
      <tr>
        <td className="muted">{formatDateTime(delivery.created_at)}</td>
        <td className="num">{delivery.event_type}</td>
        <td>
          <Badge tone={tone}>{label}</Badge>
          {delivery.next_retry_at && (
            <span className="muted hint"> next {formatDateTime(delivery.next_retry_at)}</span>
          )}
        </td>
        <td className="num">
          {delivery.response_status ?? '—'}
          {delivery.duration_ms !== null && (
            <span className="muted hint"> {delivery.duration_ms} ms</span>
          )}
        </td>
        <td className="num">#{delivery.attempt}</td>
        <td>
          <span className="row">
            <button
              type="button"
              className="btn btn-small btn-ghost"
              aria-expanded={open}
              aria-controls={detailsId}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? 'Hide' : 'Body'}
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={replay.isPending}
              aria-label={`Replay ${delivery.event_type} from ${formatDateTime(delivery.created_at)}`}
              onClick={() => replay.mutate(delivery.id)}
            >
              Replay
            </button>
          </span>
          {replay.isError && (
            <p className="field-error" role="alert">
              {errorText(replay.error)}
            </p>
          )}
        </td>
      </tr>
      {open && (
        <tr id={detailsId}>
          <td colSpan={6}>
            <div className="stack tight">
              <span className="muted hint num">Nem-Event-Id: {delivery.event_id}</span>
              <pre className="code-block">{JSON.stringify(delivery.request_body, null, 2)}</pre>
              {delivery.response_body_excerpt && (
                <span className="muted hint num">Response: {delivery.response_body_excerpt}</span>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function DeliveryLog({ endpointId }: { endpointId: string }) {
  const [filter, setFilter] = useState<DeliveryStatus | 'all'>('all');
  const log = useDeliveries(endpointId, filter === 'all' ? undefined : filter);
  const rows = log.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <section className="card stack" aria-labelledby="log-title">
      <div className="row space-between">
        <div className="stack tight">
          <h2 id="log-title">Deliveries</h2>
          <p className="muted">
            Replay sends the same event with the same Nem-Event-Id, so your handler can skip ones it
            has already processed.
          </p>
        </div>
        <Segmented label="Show deliveries" options={FILTERS} value={filter} onChange={setFilter} />
      </div>
      {log.isPending ? (
        <Skeleton height={120} />
      ) : log.isError ? (
        <ErrorState error={log.error} onRetry={() => void log.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No deliveries">Send a test event to see one here.</EmptyState>
      ) : (
        <table className="table" aria-busy={log.isFetching}>
          <thead>
            <tr>
              <th scope="col">Sent</th>
              <th scope="col">Event</th>
              <th scope="col">Result</th>
              <th scope="col">HTTP</th>
              <th scope="col">Attempt</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <DeliveryRow key={d.id} delivery={d} endpointId={endpointId} />
            ))}
          </tbody>
        </table>
      )}
      {log.hasNextPage && (
        <button
          type="button"
          className="btn"
          onClick={() => void log.fetchNextPage()}
          disabled={log.isFetchingNextPage}
        >
          {log.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
}

export function EndpointPage({ endpointId }: { endpointId: string }) {
  const endpoint = useEndpoint(endpointId);

  if (endpoint.isPending) {
    return (
      <div className="stack" aria-busy="true" aria-label="Loading endpoint">
        <Skeleton height={36} width={320} />
        <Skeleton height={240} />
      </div>
    );
  }
  if (endpoint.isError) {
    return <ErrorState error={endpoint.error} onRetry={() => void endpoint.refetch()} />;
  }
  const e = endpoint.data;

  return (
    <>
      <div className="stack tight">
        <Link to="/developers/webhooks" className="back-link">
          ← Webhooks
        </Link>
        <h1 className="num">{e.description ?? e.url}</h1>
        <p className="row">
          <Badge tone={e.status === 'active' ? 'success' : 'neutral'}>
            {e.status === 'active' ? 'On' : 'Off'}
          </Badge>
          <span className="muted">Added {formatDateTime(e.created_at)}</span>
        </p>
      </div>
      <div className="review-grid">
        <Actions endpoint={e} />
        <section className="card stack" aria-labelledby="verify-title">
          <h2 id="verify-title">Verify the signature</h2>
          <p className="muted">
            Recompute the HMAC over the timestamp and the raw body, compare in constant time, and
            reject anything older than five minutes.
          </p>
          <pre className="code-block">{VERIFY_SNIPPET}</pre>
        </section>
      </div>
      <DeliveryLog endpointId={endpointId} />
    </>
  );
}
