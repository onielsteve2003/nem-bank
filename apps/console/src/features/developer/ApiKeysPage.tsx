import { useState, type FormEvent } from 'react';

import { Badge } from '@/components/Badge';
import { EmptyState, ErrorState, Skeleton } from '@/components/PageState';
import { isApiError } from '@/data/errors';
import { DEMO_DEVELOPER_PIN } from '@/data/mock/developer';
import { useDemoControls } from '@/data/provider';
import { formatDateTime } from '@/lib/dates';

import { SecretOnce } from './SecretOnce';
import {
  useApiKeys,
  useCreateApiKey,
  useRevokeApiKey,
  type ApiKey,
  type ApiKeyScope,
} from './useDeveloper';

export const SCOPES: readonly [ApiKeyScope, string][] = [
  ['accounts_read', 'Read accounts and balances'],
  ['transactions_read', 'Read transactions'],
  ['transfers_read', 'Read transfers'],
  ['payment_links_write', 'Create payment links'],
  ['webhooks_manage', 'Manage webhook endpoints'],
];

function CreateKeyForm({ onCreated }: { onCreated: (secret: string) => void }) {
  const demo = useDemoControls();
  const create = useCreateApiKey();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['accounts_read', 'transactions_read']);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const valid = name.trim().length > 0 && scopes.length > 0 && /^\d{4}$/.test(pin);

  const toggle = (scope: ApiKeyScope) =>
    setScopes((s) => (s.includes(scope) ? s.filter((x) => x !== scope) : [...s, scope]));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    // Creating a key is sensitive, so it needs a fresh step-up: the PIN again.
    const stepUpToken = demo?.developerStepUp(pin) ?? null;
    if (!stepUpToken) {
      setPinError('That PIN is not right.');
      return;
    }
    setPinError(null);
    create.mutate(
      { name: name.trim(), scopes, stepUpToken },
      {
        onSuccess: ({ secret }) => {
          setName('');
          setPin('');
          onCreated(secret);
        },
      },
    );
  };

  return (
    <form className="card stack" onSubmit={submit} aria-labelledby="create-key-title">
      <h2 id="create-key-title">Create a key</h2>
      <label className="field">
        Name
        <input
          className="input"
          value={name}
          maxLength={40}
          placeholder="Store backend"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <fieldset className="choices">
        <legend className="field">Scopes (give a key only what it needs)</legend>
        {SCOPES.map(([scope, label]) => (
          <label key={scope} className="checkbox-label">
            <input
              type="checkbox"
              checked={scopes.includes(scope)}
              onChange={() => toggle(scope)}
            />
            {label} <span className="muted hint num">{scope}</span>
          </label>
        ))}
      </fieldset>
      <label className="field">
        Your PIN
        <input
          className="input num"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          aria-describedby="pin-hint"
        />
      </label>
      <span id="pin-hint" className={pinError ? 'field-error' : 'muted hint'}>
        {pinError ?? `Demo business PIN: ${DEMO_DEVELOPER_PIN}`}
      </span>
      {create.error != null && (
        <p className="field-error" role="alert">
          {isApiError(create.error) ? create.error.message : 'Something went wrong. Try again.'}
        </p>
      )}
      <div>
        <button type="submit" className="btn btn-primary" disabled={!valid || create.isPending}>
          {create.isPending ? 'Creating…' : 'Create key'}
        </button>
      </div>
    </form>
  );
}

function KeyRow({ apiKey }: { apiKey: ApiKey }) {
  const revoke = useRevokeApiKey();
  const [confirming, setConfirming] = useState(false);
  const revoked = apiKey.revoked_at !== null;

  return (
    <tr>
      <td>
        <div className="stack tight">
          <strong>{apiKey.name}</strong>
          <span className="muted hint num">{apiKey.prefix}…</span>
        </div>
      </td>
      <td className="muted hint num">{apiKey.scopes.join(', ')}</td>
      <td className="muted">{formatDateTime(apiKey.created_at)}</td>
      <td className="muted">
        {apiKey.last_used_at ? formatDateTime(apiKey.last_used_at) : 'Never'}
      </td>
      <td>
        {revoked ? (
          <Badge tone="neutral">Revoked {formatDateTime(apiKey.revoked_at!)}</Badge>
        ) : confirming ? (
          <span className="row">
            <button
              type="button"
              className="btn btn-small btn-danger"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(apiKey.id)}
            >
              {revoke.isPending ? 'Revoking…' : 'Yes, revoke'}
            </button>
            <button
              type="button"
              className="btn btn-small btn-ghost"
              onClick={() => setConfirming(false)}
            >
              Keep
            </button>
          </span>
        ) : (
          <span className="row">
            <Badge tone="success">Active</Badge>
            <button
              type="button"
              className="btn btn-small"
              aria-label={`Revoke ${apiKey.name}`}
              onClick={() => setConfirming(true)}
            >
              Revoke
            </button>
          </span>
        )}
        {revoke.isError && (
          <p className="field-error" role="alert">
            Could not revoke. Try again.
          </p>
        )}
      </td>
    </tr>
  );
}

/** DEV-1: sandbox API keys, shown once, stored hashed, scoped and revocable. */
export function ApiKeysPage() {
  const keys = useApiKeys();
  const [secret, setSecret] = useState<string | null>(null);

  return (
    <>
      <div className="stack tight">
        <h1>API keys</h1>
        <p className="muted">
          Keys let your server call the Nem API. Send one as{' '}
          <code className="num">Authorization: Bearer nem_test_…</code>. Revoking a key stops it
          working within a minute.
        </p>
      </div>

      {secret && (
        <SecretOnce title="Your new API key" secret={secret} onDone={() => setSecret(null)} />
      )}

      <div className="review-grid">
        {keys.isPending ? (
          <div className="card stack" aria-busy="true" aria-label="Loading keys">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} height={28} />
            ))}
          </div>
        ) : keys.isError ? (
          <ErrorState error={keys.error} onRetry={() => void keys.refetch()} />
        ) : keys.data.data.length === 0 ? (
          <EmptyState title="No keys yet">Create one to start calling the sandbox API.</EmptyState>
        ) : (
          <section className="card stack" aria-label="Keys">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Key</th>
                  <th scope="col">Scopes</th>
                  <th scope="col">Created</th>
                  <th scope="col">Last used</th>
                  <th scope="col">State</th>
                </tr>
              </thead>
              <tbody>
                {keys.data.data.map((k) => (
                  <KeyRow key={k.id} apiKey={k} />
                ))}
              </tbody>
            </table>
          </section>
        )}
        <CreateKeyForm onCreated={setSecret} />
      </div>
    </>
  );
}
