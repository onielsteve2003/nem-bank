import type { Schema } from '@nem/contracts';
import { useState, type FormEvent } from 'react';

import { isApiError } from '@/data/errors';

import { DOCUMENT_LABELS } from './labels';
import { useDecideKyc, type KycDecision } from './useKyc';

type Kind = Schema<'KycDocumentKind'>;

const CHOICES: readonly { value: KycDecision['decision']; label: string; hint: string }[] = [
  { value: 'approve', label: 'Approve', hint: 'The customer moves up a tier at once.' },
  {
    value: 'resubmit',
    label: 'Ask to resubmit',
    hint: 'For a fixable problem: a blurry photo, a cut-off bill.',
  },
  {
    value: 'reject',
    label: 'Reject',
    hint: 'For documents that are not genuine or not theirs.',
  },
];

type Props = { submissionId: string; documents: readonly Kind[] };

export function KycDecisionForm({ submissionId, documents }: Props) {
  const [decision, setDecision] = useState<KycDecision['decision']>('approve');
  const [reason, setReason] = useState('');
  const [redo, setRedo] = useState<Kind[]>([]);
  const decide = useDecideKyc(submissionId);

  const needsReason = decision !== 'approve';
  const reasonOk = !needsReason || reason.trim().length >= 5;
  const redoOk = decision !== 'resubmit' || redo.length > 0;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!reasonOk || !redoOk) return;
    decide.mutate({
      decision,
      ...(needsReason && { reason: reason.trim() }),
      ...(decision === 'resubmit' && { resubmit_documents: redo }),
    });
  };

  return (
    <form className="card stack" onSubmit={onSubmit} aria-labelledby="decision-title">
      <h2 id="decision-title">Decision</h2>
      <fieldset className="choices">
        <legend className="sr-only">Decision</legend>
        {CHOICES.map((c) => (
          <label key={c.value} className="choice">
            <input
              type="radio"
              name="decision"
              value={c.value}
              checked={decision === c.value}
              onChange={() => setDecision(c.value)}
            />
            <span className="stack tight">
              <strong>{c.label}</strong>
              <span className="muted hint">{c.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {decision === 'resubmit' && documents.length > 0 && (
        <fieldset className="choices">
          <legend className="field">Documents to upload again</legend>
          {documents.map((kind) => (
            <label key={kind} className="choice">
              <input
                type="checkbox"
                checked={redo.includes(kind)}
                onChange={(e) =>
                  setRedo((r) => (e.target.checked ? [...r, kind] : r.filter((k) => k !== kind)))
                }
              />
              {DOCUMENT_LABELS[kind]}
            </label>
          ))}
        </fieldset>
      )}

      {needsReason && (
        <label className="field">
          Message to the customer (they see this)
          <textarea
            className="input textarea"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
          <span className="muted hint">At least 5 characters. Plain words, no jargon.</span>
        </label>
      )}

      {decide.isError && (
        <p className="field-error" role="alert">
          {isApiError(decide.error) ? decide.error.message : 'Could not save the decision.'}
        </p>
      )}
      <div>
        <button
          type="submit"
          className={decision === 'reject' ? 'btn btn-danger' : 'btn btn-primary'}
          disabled={!reasonOk || !redoOk || decide.isPending}
        >
          {decide.isPending ? 'Saving…' : CHOICES.find((c) => c.value === decision)!.label}
        </button>
      </div>
    </form>
  );
}
