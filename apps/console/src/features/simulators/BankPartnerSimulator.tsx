import { useState, type FormEvent } from 'react';

import { ErrorState, Skeleton } from '@/components/PageState';
import { isApiError } from '@/data/errors';

import { useBankPartner, useSaveBankPartner, type BankPartnerSettings } from './useSimulators';

const NAME_CHECK: readonly [BankPartnerSettings['name_check'], string][] = [
  ['realistic', 'Realistic (mostly matches, some close or no match)'],
  ['always_match', 'Always matches'],
  ['always_no_match', 'Never matches'],
];

type Draft = Record<'failure' | 'timeout' | 'min' | 'max', string> & {
  name_check: BankPartnerSettings['name_check'];
};

const toDraft = (s: BankPartnerSettings): Draft => ({
  failure: String(s.failure_rate_bps / 100),
  timeout: String((s.timeout_rate_bps ?? 0) / 100),
  min: String(s.min_delay_seconds),
  max: String(s.max_delay_seconds),
  name_check: s.name_check,
});

/** "2.5" (percent) → 250 bps; null if it isn't 0 to 100 with at most two decimals. */
function percentToBps(text: string): number | null {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text.trim())) return null;
  const bps = Math.round(Number(text) * 100);
  return bps <= 10_000 ? bps : null;
}

function seconds(text: string, max: number): number | null {
  if (!/^\d{1,3}$/.test(text.trim())) return null;
  const n = Number(text);
  return n <= max ? n : null;
}

function Form({ saved }: { saved: BankPartnerSettings }) {
  const save = useSaveBankPartner();
  const [draft, setDraft] = useState(() => toDraft(saved));
  const set = (field: keyof Draft) => (value: string) => {
    save.reset();
    setDraft((d) => ({ ...d, [field]: value }));
  };

  const failure = percentToBps(draft.failure);
  const timeout = percentToBps(draft.timeout);
  const min = seconds(draft.min, 300);
  const max = seconds(draft.max, 600);
  const errors = {
    failure: failure === null ? 'A percentage from 0 to 100.' : null,
    timeout:
      timeout === null
        ? 'A percentage from 0 to 100.'
        : failure !== null && failure + timeout > 10_000
          ? 'Failures and timeouts together can be at most 100%.'
          : null,
    min: min === null ? 'Whole seconds from 0 to 300.' : null,
    max:
      max === null
        ? 'Whole seconds from 0 to 600.'
        : min !== null && max < min
          ? 'At least the shortest delay.'
          : null,
  };
  const valid = Object.values(errors).every((e) => e === null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    save.mutate({
      failure_rate_bps: failure!,
      timeout_rate_bps: timeout!,
      min_delay_seconds: min!,
      max_delay_seconds: max!,
      name_check: draft.name_check,
    });
  };

  const field = (key: keyof typeof errors, label: string, suffix: string) => (
    <label className="field">
      {label}
      <span className="row">
        <input
          className="input num"
          inputMode="decimal"
          value={draft[key]}
          onChange={(e) => set(key)(e.target.value)}
          aria-invalid={errors[key] !== null}
          aria-describedby={`bp-${key}-hint`}
        />
        <span className="muted">{suffix}</span>
      </span>
      <span id={`bp-${key}-hint`} className={errors[key] ? 'field-error' : 'muted hint'}>
        {errors[key] ?? ' '}
      </span>
    </label>
  );

  return (
    <form className="stack" onSubmit={submit} aria-label="Bank Partner settings">
      <div className="config-fields">
        {field('failure', 'Transfers that fail', '%')}
        {field('timeout', 'Transfers that time out', '%')}
        {field('min', 'Shortest delay', 'seconds')}
        {field('max', 'Longest delay', 'seconds')}
      </div>
      <label className="field">
        Name check (Confirmation of Payee)
        <select
          className="select"
          value={draft.name_check}
          onChange={(e) => set('name_check')(e.target.value)}
        >
          {NAME_CHECK.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {valid && (
        <p className="muted">
          Of every 100 interbank transfers, about {(failure! / 100).toLocaleString('en-NG')} fail
          and {(timeout! / 100).toLocaleString('en-NG')} time out (and are reversed after a
          requery). The rest complete after {min} to {max} seconds.
        </p>
      )}
      {save.error != null && (
        <p className="field-error" role="alert">
          {isApiError(save.error) ? save.error.message : 'Something went wrong. Try again.'}
        </p>
      )}
      {save.isSuccess && (
        <p className="muted" role="status">
          Saved. New transfers use these settings.
        </p>
      )}
      <div>
        <button type="submit" className="btn btn-primary" disabled={!valid || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </form>
  );
}

export function BankPartnerSimulator() {
  const settings = useBankPartner();
  return (
    <section className="card stack" aria-labelledby="partner-title">
      <div className="stack tight">
        <h2 id="partner-title">Bank Partner Simulator</h2>
        <p className="muted">
          How the sandbox interbank rail behaves for transfers to other banks: how often it fails or
          times out, how long it takes, and how the name check answers. Use it to rehearse failed,
          slow and reversed transfers.
        </p>
      </div>
      {settings.isPending ? (
        <Skeleton height={160} />
      ) : settings.isError ? (
        <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
      ) : (
        <Form saved={settings.data} />
      )}
    </section>
  );
}
