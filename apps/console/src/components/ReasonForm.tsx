import { useId, useState, type FormEvent, type ReactNode } from 'react';

import { isApiError } from '@/data/errors';

type Props = {
  title: string;
  description?: ReactNode;
  submitLabel: string;
  /** The contract's limits for a staff reason (ReasonRequest). */
  minLength?: number;
  maxLength?: number;
  pending: boolean;
  error: unknown;
  danger?: boolean;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
};

/** A staff action that needs a written reason: freeze, unfreeze, reject. */
export function ReasonForm({
  title,
  description,
  submitLabel,
  minLength = 5,
  maxLength = 500,
  pending,
  error,
  danger = false,
  onSubmit,
  onCancel,
}: Props) {
  const [reason, setReason] = useState('');
  const id = useId();
  const length = reason.trim().length;
  const valid = length >= minLength && length <= maxLength;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) onSubmit(reason.trim());
  };

  return (
    <form className="card stack action-form" onSubmit={submit} aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{title}</h3>
      {description && <p className="muted">{description}</p>}
      <label className="field">
        Reason (recorded in the audit log)
        <textarea
          className="input textarea"
          value={reason}
          maxLength={maxLength}
          onChange={(e) => setReason(e.target.value)}
          aria-describedby={`${id}-count`}
          autoFocus
        />
      </label>
      <span id={`${id}-count`} className="muted hint">
        {length < minLength ? `At least ${minLength} characters` : `${length} / ${maxLength}`}
      </span>
      {error != null && (
        <p className="field-error" role="alert">
          {isApiError(error) ? error.message : 'Something went wrong. Try again.'}
        </p>
      )}
      <div className="row">
        <button
          type="submit"
          className={danger ? 'btn btn-danger' : 'btn btn-primary'}
          disabled={!valid || pending}
        >
          {pending ? 'Saving…' : submitLabel}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
