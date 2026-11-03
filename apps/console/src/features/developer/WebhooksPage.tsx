import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';

import { Badge } from '@/components/Badge';
import { EmptyState, ErrorState, Skeleton } from '@/components/PageState';
import { isApiError } from '@/data/errors';
import { formatDateTime } from '@/lib/dates';

import { SecretOnce } from './SecretOnce';
import { useCreateEndpoint, useEndpoints, type WebhookEventType } from './useDeveloper';

export const EVENTS: readonly [WebhookEventType, string][] = [
  ['payment_link.paid', 'A payment link was paid'],
  ['transfer.completed', 'A transfer completed'],
  ['transfer.failed', 'A transfer failed'],
  ['transfer.reversed', 'A transfer was reversed'],
  ['account.credited', 'Money arrived in an account'],
  ['test.ping', 'Test events you send'],
];

const isHttps = (url: string) => {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
};

function CreateEndpointForm({ onCreated }: { onCreated: (secret: string) => void }) {
  const create = useCreateEndpoint();
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<WebhookEventType[]>(['payment_link.paid']);
  const urlError = url.trim() && !isHttps(url.trim()) ? 'Use an https:// URL.' : null;
  const valid = isHttps(url.trim()) && events.length > 0;

  const toggle = (e: WebhookEventType) =>
    setEvents((list) => (list.includes(e) ? list.filter((x) => x !== e) : [...list, e]));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    create.mutate(
      { url: url.trim(), description: description.trim() || undefined, events },
      {
        onSuccess: ({ signing_secret }) => {
          setUrl('');
          setDescription('');
          onCreated(signing_secret);
        },
      },
    );
  };

  return (
    <form className="card stack" onSubmit={submit} aria-labelledby="create-endpoint-title">
      <h2 id="create-endpoint-title">Add an endpoint</h2>
      <label className="field">
        URL
        <input
          className="input"
          type="url"
          value={url}
          maxLength={500}
          placeholder="https://your-store.com/webhooks/nem"
          onChange={(e) => setUrl(e.target.value)}
          aria-invalid={urlError !== null}
          aria-describedby="url-hint"
        />
      </label>
      <span id="url-hint" className={urlError ? 'field-error' : 'muted hint'}>
        {urlError ?? 'In the sandbox, a URL containing "fail" answers 500 so you can see retries.'}
      </span>
      <label className="field">
        Description (optional)
        <input
          className="input"
          value={description}
          maxLength={100}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <fieldset className="choices">
        <legend className="field">Events</legend>
        {EVENTS.map(([type, label]) => (
          <label key={type} className="checkbox-label">
            <input type="checkbox" checked={events.includes(type)} onChange={() => toggle(type)} />
            {label} <span className="muted hint num">{type}</span>
          </label>
        ))}
      </fieldset>
      {create.error != null && (
        <p className="field-error" role="alert">
          {isApiError(create.error) ? create.error.message : 'Something went wrong. Try again.'}
        </p>
      )}
      <div>
        <button type="submit" className="btn btn-primary" disabled={!valid || create.isPending}>
          {create.isPending ? 'Adding…' : 'Add endpoint'}
        </button>
      </div>
    </form>
  );
}

/** DEV-3: where Nem sends signed events, with the signing secret shown once. */
export function WebhooksPage() {
  const endpoints = useEndpoints();
  const [secret, setSecret] = useState<string | null>(null);

  return (
    <>
      <div className="stack tight">
        <h1>Webhooks</h1>
        <p className="muted">
          Nem POSTs events to your endpoints, signed with HMAC-SHA256 in the{' '}
          <code className="num">Nem-Signature</code> header. Failed deliveries retry with
          exponential backoff for up to 3 days.
        </p>
      </div>

      {secret && (
        <SecretOnce title="Your signing secret" secret={secret} onDone={() => setSecret(null)} />
      )}

      <div className="review-grid">
        {endpoints.isPending ? (
          <div className="card stack" aria-busy="true" aria-label="Loading endpoints">
            {Array.from({ length: 2 }, (_, i) => (
              <Skeleton key={i} height={40} />
            ))}
          </div>
        ) : endpoints.isError ? (
          <ErrorState error={endpoints.error} onRetry={() => void endpoints.refetch()} />
        ) : endpoints.data.data.length === 0 ? (
          <EmptyState title="No endpoints yet">Add one to start receiving events.</EmptyState>
        ) : (
          <section className="card stack" aria-label="Endpoints">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Endpoint</th>
                  <th scope="col">Events</th>
                  <th scope="col">State</th>
                </tr>
              </thead>
              <tbody>
                {endpoints.data.data.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <div className="stack tight">
                        <Link
                          to="/developers/webhooks/$endpointId"
                          params={{ endpointId: e.id }}
                          className="num"
                        >
                          {e.url}
                        </Link>
                        <span className="muted hint">
                          {e.description ?? 'No description'} · added {formatDateTime(e.created_at)}
                        </span>
                      </div>
                    </td>
                    <td className="muted hint num">{e.events.join(', ')}</td>
                    <td>
                      {e.status === 'disabled' ? (
                        <Badge tone="neutral">Off</Badge>
                      ) : e.consecutive_failures > 0 ? (
                        <Badge tone="warning">Failing ({e.consecutive_failures})</Badge>
                      ) : (
                        <Badge tone="success">Healthy</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        <CreateEndpointForm onCreated={setSecret} />
      </div>
    </>
  );
}
