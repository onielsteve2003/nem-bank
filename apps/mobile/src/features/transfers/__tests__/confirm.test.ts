import type { Schema } from '@nem/contracts';

import { problem } from '@/data';

import { canCancel, outcomeOf, riskReasonsOf, sendErrorMessage } from '../confirm';

describe('outcomeOf', () => {
  it.each([
    ['completed', 'sent'],
    ['processing', 'processing'],
    ['risk_checked', 'processing'],
    ['pending_step_up', 'step_up'],
    ['delayed', 'delayed'],
    ['held_for_review', 'held'],
    ['rejected', 'stopped'],
    ['cancelled', 'stopped'],
    ['reversed', 'stopped'],
  ] as const)('%s → %s', (status, outcome) => {
    expect(outcomeOf(status)).toBe(outcome);
  });

  it('only lets waiting transfers be cancelled', () => {
    expect(canCancel('held_for_review')).toBe(true);
    expect(canCancel('delayed')).toBe(true);
    expect(canCancel('processing')).toBe(false);
  });
});

it('maps the bank reasons for RiskReasonList', () => {
  const transfer = {
    risk: {
      decision: 'hold',
      score: 0.9,
      model_version: 'rules-1',
      reasons: [{ code: 'large_amount', severity: 'high', message: 'Much larger than usual.' }],
    },
  } as Schema<'Transfer'>;
  expect(riskReasonsOf(transfer)).toEqual([
    { code: 'large_amount', severity: 'high', label: 'Much larger than usual.' },
  ]);
});

describe('sendErrorMessage', () => {
  it('asks for a new price when the quote is stale or the balance changed', () => {
    expect(sendErrorMessage(problem(409, 'quote_expired', 'Quote expired')).requote).toBe(true);
    expect(
      sendErrorMessage(
        problem(422, 'insufficient_funds', 'Insufficient funds', { detail: 'Need ₦5,050.00' }),
      ),
    ).toEqual({ message: 'Need ₦5,050.00', requote: true });
  });

  it('says a retry after a lost answer is safe', () => {
    expect(sendErrorMessage(problem(504, 'gateway_timeout', 'Timeout')).message).toMatch(
      /won't send twice/,
    );
  });
});
