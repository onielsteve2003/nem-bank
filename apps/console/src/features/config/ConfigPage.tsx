import { useId, useState, type FormEvent } from 'react';

import { ErrorState, Skeleton } from '@/components/PageState';
import { isApiError } from '@/data/errors';
import { canCall } from '@/features/auth/access';
import { useSession } from '@/features/auth/session';
import { formatDateTime } from '@/lib/dates';

import {
  displayValue,
  inputValue,
  parseField,
  sameValue,
  sectionsFor,
  type FieldValue,
  type SectionDef,
} from './sections';
import {
  useBankConfig,
  useRequestConfigChange,
  type BankConfig,
  type ConfigChange,
} from './useConfig';

/** ADM-8: the live fees, limits, spreads and cool-off rules; changes go to maker-checker. */
export function ConfigPage() {
  const query = useBankConfig();
  const roles = useSession((s) => s.session?.staff.roles) ?? [];
  const canPropose = canCall(roles, 'requestConfigChange');

  if (query.isPending) {
    return (
      <div className="stack" aria-busy="true" aria-label="Loading configuration">
        <Skeleton height={36} width={280} />
        <div className="detail-grid">
          <Skeleton height={220} />
          <Skeleton height={220} />
        </div>
      </div>
    );
  }
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const config = query.data;
  return (
    <>
      <div className="stack tight">
        <h1>Configuration</h1>
        <p className="muted">
          Version <span className="num">{config.version}</span> · updated{' '}
          {formatDateTime(config.updated_at)}. A change applies once a second person approves it.
        </p>
      </div>
      <div className="detail-grid">
        {sectionsFor(config).map((def) => (
          // Keyed by version so an open form resets when the config moves on.
          <SectionCard
            key={`${def.section}-${config.version}`}
            def={def}
            config={config}
            canPropose={canPropose}
          />
        ))}
      </div>
    </>
  );
}

type CardProps = { def: SectionDef; config: BankConfig; canPropose: boolean };

function SectionCard({ def, config, canPropose }: CardProps) {
  const [editing, setEditing] = useState(false);
  const change = useRequestConfigChange();
  const id = useId();

  return (
    <section className="card stack" aria-labelledby={`${id}-title`}>
      <div className="row space-between">
        <h2 id={`${id}-title`}>{def.title}</h2>
        {canPropose && !editing && !change.data && (
          <button type="button" className="btn btn-ghost" onClick={() => setEditing(true)}>
            Propose change
          </button>
        )}
      </div>
      <p className="muted hint">{def.description}</p>

      {change.data ? (
        <div className="stack tight" role="status">
          <strong>Waiting for a second approver</strong>
          <span className="muted">
            {change.data.summary}. It shows in the Approvals inbox until someone else approves it.
          </span>
        </div>
      ) : editing ? (
        <ChangeForm
          def={def}
          pending={change.isPending}
          error={change.error}
          onCancel={() => {
            change.reset();
            setEditing(false);
          }}
          onSubmit={(value, reason) =>
            change.mutate({ section: def.section, value, reason, base_version: config.version })
          }
        />
      ) : (
        <dl className="facts">
          {def.fields.map((f) => (
            <div key={f.key} className="contents">
              <dt>{f.label}</dt>
              <dd className="num">{displayValue(f)}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

type FormProps = {
  def: SectionDef;
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (value: ConfigChange['value'], reason: string) => void;
};

function ChangeForm({ def, pending, error, onCancel, onSubmit }: FormProps) {
  const [text, setText] = useState<Record<string, string>>(() =>
    Object.fromEntries(def.fields.map((f) => [f.key, inputValue(f)])),
  );
  const [reason, setReason] = useState('');
  const id = useId();

  const parsed = def.fields.map((f) => ({ f, result: parseField(f, text[f.key] ?? '') }));
  const changed = parsed.filter(
    ({ f, result }) => 'value' in result && !sameValue(result.value, f.value),
  ).length;
  const hasError = parsed.some(({ result }) => 'error' in result);
  const reasonOk = reason.trim().length >= 5;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (hasError || changed === 0 || !reasonOk) return;
    const values: Record<string, FieldValue> = {};
    for (const { f, result } of parsed) if ('value' in result) values[f.key] = result.value;
    onSubmit(def.toValue(values) as ConfigChange['value'], reason.trim());
  };

  return (
    <form className="stack" onSubmit={submit} aria-label={`Change ${def.title}`}>
      <div className="config-fields">
        {parsed.map(({ f, result }) => {
          const err = 'error' in result ? result.error : null;
          return (
            <label key={f.key} className="field">
              {f.label}
              {f.unit && <span className="muted hint"> ({f.unit})</span>}
              <input
                className="input num"
                inputMode={f.kind === 'int' || f.kind === 'bps' ? 'numeric' : 'decimal'}
                value={text[f.key] ?? ''}
                placeholder={f.kind === 'naira_or_none' ? 'No maximum' : undefined}
                aria-invalid={Boolean(err)}
                aria-describedby={err ? `${id}-${f.key}-err` : undefined}
                onChange={(e) => setText((t) => ({ ...t, [f.key]: e.target.value }))}
              />
              {err && (
                <span id={`${id}-${f.key}-err`} className="field-error">
                  {err}
                </span>
              )}
            </label>
          );
        })}
      </div>
      <label className="field">
        Reason (the approver sees this)
        <textarea
          className="input textarea"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <span className="muted hint">
        {changed === 0
          ? 'Nothing changed yet.'
          : `${changed} value${changed === 1 ? '' : 's'} changed.`}
        {!reasonOk && ' A reason needs at least 5 characters.'}
      </span>
      {error != null && (
        <p className="field-error" role="alert">
          {isApiError(error) ? error.message : 'Could not send the change. Try again.'}
        </p>
      )}
      <div className="row">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={hasError || changed === 0 || !reasonOk || pending}
        >
          {pending ? 'Sending…' : 'Send for approval'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
