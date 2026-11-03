import type { StaffRole } from '@nem/contracts';
import { describe, expect, it } from 'vitest';

import { isApiError } from '../errors';
import { repositoriesFromDispatcher } from '../repositories';
import { switchDemoRole } from './auth';
import { customerId } from './customerSeed';
import { fraudCaseId } from './fraudSeed';
import { createMockDispatcher } from './index';
import { createMockState, type MockState } from './state';

function reposAs(role: StaffRole, state: MockState = createMockState()) {
  const { access_token } = switchDemoRole(state, role);
  return repositoriesFromDispatcher(
    createMockDispatcher({ latencyMs: 0, state, getAccessToken: () => access_token }),
  );
}

// Seed order: 1 Emeka (score 0.93, open), 5 Kelechi (in review with Aisha).
const EMEKA_CASE = fraudCaseId(1);
const KELECHI_CASE = fraudCaseId(5);

describe('mock fraud cases', () => {
  it('lists the work to do, highest score first, and filters by outcome and owner', async () => {
    const repos = reposAs('compliance');
    const active = await repos.fraud.list();
    const scores = active.data.map((c) => c.risk.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(new Set(active.data.map((c) => c.status))).toEqual(new Set(['open', 'in_review']));

    const mine = await repos.fraud.list({ query: { assigned_to_me: true } });
    expect(mine.data.map((c) => c.id)).toEqual([KELECHI_CASE]);
    const released = await repos.fraud.list({ query: { status: 'released' } });
    expect(released.data[0]!.label).toBe('legitimate');
  });

  it('lets one reviewer take a case and refuses a second', async () => {
    const state = createMockState();
    const taken = await reposAs('admin', state).fraud.assign({ path: { case_id: EMEKA_CASE } });
    expect(taken).toMatchObject({ status: 'in_review', assignee: { name: 'Ifeoma Adeyemi' } });
    await expect(
      reposAs('compliance', state).fraud.assign({ path: { case_id: EMEKA_CASE } }),
    ).rejects.toSatisfy((e) => isApiError(e, 'already_assigned'));
  });

  it('needs the case taken before deciding, and rejects a release labelled fraud', async () => {
    const repos = reposAs('compliance');
    const body = { decision: 'reject' as const, label: 'fraud' as const };
    await expect(
      repos.fraud.decide({ path: { case_id: EMEKA_CASE }, body, idempotencyKey: 'k1' }),
    ).rejects.toSatisfy((e) => isApiError(e, 'not_assigned'));
    await expect(
      repos.fraud.decide({
        path: { case_id: KELECHI_CASE },
        body: { decision: 'release', label: 'fraud' },
        idempotencyKey: 'k2',
      }),
    ).rejects.toSatisfy((e) => isApiError(e, 'validation_failed'));
  });

  it('rejecting stops the transfer, stores the label and closes the customer case once', async () => {
    const state = createMockState();
    const repos = reposAs('compliance', state);
    const kelechi = customerId(11);
    const before = state.customers.get(kelechi)!.view.open_cases.fraud;
    const input = {
      path: { case_id: KELECHI_CASE },
      body: {
        decision: 'reject' as const,
        label: 'fraud' as const,
        note: 'Dealer account flagged by two other banks.',
      },
      idempotencyKey: 'decision-1',
    };
    const closed = await repos.fraud.decide(input);
    expect(closed).toMatchObject({ status: 'rejected', label: 'fraud' });
    expect(closed.transfer.status).toBe('rejected');
    expect(closed.transfer.timeline.at(-1)!.label).toMatch(/money returned/);

    // A retry with the same key returns the first result and changes nothing.
    expect(await repos.fraud.decide(input)).toEqual(closed);
    expect(state.customers.get(kelechi)!.view.open_cases.fraud).toBe(before - 1);

    await expect(repos.fraud.decide({ ...input, idempotencyKey: 'decision-2' })).rejects.toSatisfy(
      (e) => isApiError(e, 'conflict'),
    );
  });

  it('keeps fraud away from support and finance', async () => {
    for (const role of ['support', 'finance'] as const) {
      await expect(reposAs(role).fraud.list()).rejects.toSatisfy((e) => isApiError(e, 'forbidden'));
    }
  });
});
