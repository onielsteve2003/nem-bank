import { compare, formatMoney, parseMajor } from '@nem/shared';
import { useState, type FormEvent } from 'react';

import { isApiError } from '@/data/errors';
import { fromApiMoney } from '@/lib/money';

import {
  isApproval,
  useDecideDispute,
  type AdminDispute,
  type DisputeDecision,
} from './useDisputes';

const OUTCOMES: readonly { value: DisputeDecision['outcome']; label: string; hint: string }[] = [
  { value: 'refund', label: 'Refund', hint: 'Money goes back through the ledger.' },
  { value: 'decline', label: 'Decline', hint: 'The charge stands. Explain why.' },
  { value: 'request_info', label: 'Ask for more', hint: 'The customer is asked for evidence.' },
];

/** Parses the refund box; null with a message when it can't be refunded. */
function parseRefund(text: string, disputed: AdminDispute['transaction']['amount']) {
  const max = fromApiMoney(disputed);
  try {
    const amount = parseMajor(text, max.currency);
    if (amount.amount <= 0n) return { error: 'Enter an amount above zero.' };
    if (compare(amount, max) > 0) return { error: `At most ${formatMoney(max)}.` };
    return { amount };
  } catch {
    return { error: 'Enter an amount like 10000 or 10,000.50.' };
  }
}

/** Refund (in full or part), decline, or ask the customer for more. */
export function DisputeDecisionForm({ dispute: d }: { dispute: AdminDispute }) {
  const disputed = d.transaction.amount;
  const [outcome, setOutcome] = useState<DisputeDecision['outcome']>('refund');
  const [refundText, setRefundText] = useState(() =>
    formatMoney(fromApiMoney(disputed), { symbol: false }),
  );
  const [note, setNote] = useState('');
  // Kept for the life of the form, so a retry after a lost response is the same request.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const decide = useDecideDispute(d.dispute.id);
  const refund = outcome === 'refund' ? parseRefund(refundText, disputed) : null;
  const noteLength = note.trim().length;
  const valid = noteLength >= 5 && noteLength <= 1000 && !refund?.error;

  if (decide.data && isApproval(decide.data)) {
    return (
      <section className="card stack" role="status" aria-labelledby="refund-approval-title">
        <h2 id="refund-approval-title">Waiting for a second approver</h2>
        <p>{decide.data.summary}</p>
        <p className="muted">
          Refunds this large need another Compliance or Admin member to approve them in the
          Approvals inbox. The customer sees “in review” until then.
        </p>
      </section>
    );
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    decide.mutate({
      idempotencyKey,
      body: {
        outcome,
        note: note.trim(),
        ...(refund?.amount && {
          refund_amount: {
            amount_minor: refund.amount.amount.toString(),
            currency: refund.amount.currency,
          },
        }),
      },
    });
  };

  return (
    <form className="card stack" onSubmit={onSubmit} aria-labelledby="dispute-decision-title">
      <h2 id="dispute-decision-title">Decision</h2>
      <fieldset className="choices">
        <legend className="sr-only">Outcome</legend>
        {OUTCOMES.map((o) => (
          <label key={o.value} className="choice">
            <input
              type="radio"
              name="outcome"
              checked={outcome === o.value}
              onChange={() => setOutcome(o.value)}
            />
            <span className="stack tight">
              <strong>{o.label}</strong>
              <span className="muted hint">{o.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {outcome === 'refund' && (
        <label className="field">
          Refund amount ({disputed.currency})
          <input
            className="input num"
            inputMode="decimal"
            value={refundText}
            onChange={(e) => setRefundText(e.target.value)}
            aria-invalid={Boolean(refund?.error)}
            aria-describedby="refund-hint"
          />
          <span id="refund-hint" className={refund?.error ? 'field-error' : 'muted hint'}>
            {refund?.error ?? 'Lower it for a partial refund.'}
          </span>
        </label>
      )}

      <label className="field">
        {outcome === 'request_info' ? 'What do you need from them?' : 'Note to the customer'}
        <textarea
          className="input textarea"
          value={note}
          maxLength={1000}
          onChange={(e) => setNote(e.target.value)}
          aria-describedby="dispute-note-hint"
        />
      </label>
      <span id="dispute-note-hint" className="muted hint">
        {noteLength < 5 ? 'At least 5 characters. ' : ''}The customer sees this in the app.
      </span>

      {decide.isError && (
        <p className="field-error" role="alert">
          {isApiError(decide.error) ? decide.error.message : 'Could not save the decision.'}
        </p>
      )}
      <div>
        <button
          type="submit"
          className={outcome === 'decline' ? 'btn btn-danger' : 'btn btn-primary'}
          disabled={!valid || decide.isPending}
        >
          {decide.isPending
            ? 'Saving…'
            : outcome === 'refund'
              ? 'Refund'
              : outcome === 'decline'
                ? 'Decline dispute'
                : 'Ask the customer'}
        </button>
      </div>
    </form>
  );
}
