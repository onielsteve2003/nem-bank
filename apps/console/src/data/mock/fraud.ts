import { problem } from '../errors';
import { findCustomer } from './customers';
import type { FraudCase } from './fraudSeed';
import type { Handlers } from './handlers';
import { paginate, staffRef } from './paging';
import type { MockState } from './state';

const ACTIVE: readonly FraudCase['status'][] = ['open', 'in_review'];

function findCase(state: MockState, caseId: string): FraudCase {
  const found = state.fraud.get(caseId);
  if (!found) throw problem(404, 'not_found', 'No fraud case with that ID');
  return found;
}

/** The customer as they are now (a freeze since the hold shows), not as when it was held. */
const view = (state: MockState, c: FraudCase): FraudCase =>
  structuredClone({ ...c, customer: findCustomer(state, c.customer.user_id).view.customer });

export const fraudHandlers: Handlers = {
  listFraudCases: ({ query } = {}, { state, staff }) => {
    const rows = [...state.fraud.values()]
      // No status means the work still to do: open and in review.
      .filter((c) => (query?.status ? c.status === query.status : ACTIVE.includes(c.status)))
      .filter((c) => !query?.assigned_to_me || c.assignee?.id === staff?.id)
      // Highest score first (ADM-5); the oldest hold breaks a tie.
      .sort((a, b) => b.risk.score - a.risk.score || a.created_at.localeCompare(b.created_at))
      .map((c) => view(state, c));
    return paginate(rows, query?.cursor, query?.limit);
  },

  getFraudCase: ({ path }, { state }) => view(state, findCase(state, path.case_id)),

  assignFraudCase: ({ path }, { state, staff }) => {
    const c = findCase(state, path.case_id);
    const me = staffRef(staff);
    if (!ACTIVE.includes(c.status)) throw problem(409, 'conflict', 'This case is closed');
    if (c.assignee && c.assignee.id !== me.id) {
      throw problem(409, 'already_assigned', `${c.assignee.name} is already on this case`);
    }
    c.assignee = me;
    c.status = 'in_review';
    return view(state, c);
  },

  decideFraudCase: ({ path, body, idempotencyKey }, { state, staff }) => {
    // A retried decision (lost response, double click) returns the first result.
    const replay = state.idempotency.get(idempotencyKey);
    if (replay) return structuredClone(replay as FraudCase);

    const c = findCase(state, path.case_id);
    const me = staffRef(staff);
    if (!ACTIVE.includes(c.status)) throw problem(409, 'conflict', 'This case is already closed');
    if (c.assignee?.id !== me.id) {
      throw problem(409, 'not_assigned', 'Take the case before deciding it');
    }
    // A label is training data: releasing money while calling it fraud would poison it.
    if (body.decision === 'release' && body.label === 'fraud') {
      throw problem(422, 'validation_failed', 'A released transfer cannot be labelled fraud', {
        errors: [{ field: '/label', code: 'conflict', message: 'Pick legitimate or unsure.' }],
      });
    }

    const at = new Date(state.now()).toISOString();
    const released = body.decision === 'release';
    c.status = released ? 'released' : 'rejected';
    c.label = body.label;
    c.note = body.note?.trim() || null;
    c.closed_at = at;
    c.transfer = {
      ...c.transfer,
      status: released ? 'completed' : 'rejected',
      updated_at: at,
      timeline: [
        ...c.transfer.timeline,
        released
          ? { status: 'completed', label: 'Released after review and sent', at, detail: null }
          : {
              status: 'rejected',
              label: 'Stopped after review; money returned',
              at,
              detail: body.customer_message?.trim() || null,
            },
      ],
    };
    findCustomer(state, c.customer.user_id).view.open_cases.fraud -= 1;

    const result = view(state, c);
    state.idempotency.set(idempotencyKey, result);
    return structuredClone(result);
  },
};
