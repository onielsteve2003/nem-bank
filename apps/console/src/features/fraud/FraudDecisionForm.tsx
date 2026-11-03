import { useState, type FormEvent } from 'react';

import { isApiError } from '@/data/errors';

import { LABELS } from './labels';
import { useDecideFraudCase, type FraudDecision } from './useFraud';

/** Release or reject a held transfer, with the ground-truth label the model retrains on. */
export function FraudDecisionForm({ caseId }: { caseId: string }) {
  const [decision, setDecision] = useState<FraudDecision['decision']>('release');
  const [label, setLabel] = useState<FraudDecision['label']>('legitimate');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');
  // Kept for the life of the form, so a retry after a lost response is the same request.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const decide = useDecideFraudCase(caseId);
  const contradictory = decision === 'release' && label === 'fraud';

  const choose = (next: FraudDecision['decision']) => {
    setDecision(next);
    // The usual label for each outcome; staff can still change it.
    setLabel(next === 'release' ? 'legitimate' : 'fraud');
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (contradictory) return;
    decide.mutate({
      idempotencyKey,
      body: {
        decision,
        label,
        ...(note.trim() && { note: note.trim() }),
        ...(message.trim() && { customer_message: message.trim() }),
      },
    });
  };

  return (
    <form className="card stack" onSubmit={onSubmit} aria-labelledby="fraud-decision-title">
      <h2 id="fraud-decision-title">Decision</h2>
      <fieldset className="choices">
        <legend className="sr-only">Outcome</legend>
        <label className="choice">
          <input
            type="radio"
            name="decision"
            checked={decision === 'release'}
            onChange={() => choose('release')}
          />
          <span className="stack tight">
            <strong>Release</strong>
            <span className="muted hint">The transfer goes out now.</span>
          </span>
        </label>
        <label className="choice">
          <input
            type="radio"
            name="decision"
            checked={decision === 'reject'}
            onChange={() => choose('reject')}
          />
          <span className="stack tight">
            <strong>Reject</strong>
            <span className="muted hint">The transfer stops and the money returns.</span>
          </span>
        </label>
      </fieldset>

      <fieldset className="choices">
        <legend className="field">Label (trains the fraud model)</legend>
        <div className="segmented">
          {LABELS.map((l) => (
            <label key={l.value} className="segment segment-radio" title={l.hint}>
              <input
                type="radio"
                name="label"
                className="sr-only"
                checked={label === l.value}
                onChange={() => setLabel(l.value)}
              />
              {l.label}
            </label>
          ))}
        </div>
        <span className="muted hint">{LABELS.find((l) => l.value === label)!.hint}</span>
        {contradictory && (
          <p className="field-error" role="alert">
            A released transfer can’t be labelled fraud. Pick Legitimate or Unsure, or reject it.
          </p>
        )}
      </fieldset>

      <label className="field">
        Internal note (staff only)
        <textarea
          className="input textarea"
          value={note}
          maxLength={1000}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <label className="field">
        Message to the customer (optional)
        <input
          className="input"
          value={message}
          maxLength={300}
          onChange={(e) => setMessage(e.target.value)}
        />
        <span className="muted hint">They are notified either way.</span>
      </label>

      {decide.isError && (
        <p className="field-error" role="alert">
          {isApiError(decide.error) ? decide.error.message : 'Could not save the decision.'}
        </p>
      )}
      <div>
        <button
          type="submit"
          className={decision === 'reject' ? 'btn btn-danger' : 'btn btn-primary'}
          disabled={contradictory || decide.isPending}
        >
          {decide.isPending
            ? 'Saving…'
            : decision === 'release'
              ? 'Release transfer'
              : 'Reject transfer'}
        </button>
      </div>
    </form>
  );
}
