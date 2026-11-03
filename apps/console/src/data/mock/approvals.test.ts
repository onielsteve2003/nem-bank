import type { StaffRole } from '@nem/contracts';
import { describe, expect, it } from 'vitest';

import { isApiError } from '../errors';
import { repositoriesFromDispatcher } from '../repositories';
import { tamperAudit, verifyChain } from './audit';
import { switchDemoRole } from './auth';
import { customerId } from './customerSeed';
import { createMockDispatcher } from './index';
import { createMockState, type MockState } from './state';

function reposAs(role: StaffRole, state: MockState) {
  const { access_token } = switchDemoRole(state, role);
  return repositoriesFromDispatcher(
    createMockDispatcher({ latencyMs: 0, state, getAccessToken: () => access_token }),
  );
}

const is = (code: string) => (e: unknown) => isApiError(e, code);
const NGOZI = customerId(5);
const COOLING_OFF = '01900000-0000-7000-8000-0000000f0003';

describe('audit log', () => {
  it('seeds a chain that verifies, newest first', async () => {
    const state = createMockState();
    const repos = reposAs('compliance', state);
    const page = await repos.audit.list({ query: { limit: 100 } });
    expect(page.data[0]!.seq).toBe(state.audit.length);
    expect(page.data.at(-1)!.prev_hash).toBe('0'.repeat(64));
    await expect(repos.audit.verify({ body: {} })).resolves.toMatchObject({
      valid: true,
      checked: state.audit.length,
      first_broken_seq: null,
    });
  });

  it('records staff writes with IDs only, and not reads', async () => {
    const state = createMockState();
    const repos = reposAs('admin', state);
    const before = state.audit.length;
    await repos.customers.get({ path: { user_id: NGOZI } });
    expect(state.audit).toHaveLength(before);

    await repos.customers.addNote({ path: { user_id: NGOZI }, body: { body: 'Called her back.' } });
    expect(state.audit.at(-1)).toMatchObject({
      actor: { type: 'staff', name: 'Ifeoma Adeyemi' },
      action: 'customer.note',
      resource: { type: 'customer', id: NGOZI },
      metadata: {},
    });
    expect(verifyChain(state.audit).firstBroken).toBeNull();
  });

  it('filters by action prefix and resource', async () => {
    const repos = reposAs('admin', createMockState());
    const { data } = await repos.audit.list({ query: { action: 'customer', resource_id: NGOZI } });
    expect(data.map((e) => e.action)).toEqual(['customer.note', 'customer.freeze']);
  });

  it('finds the first entry that was changed after it was written', async () => {
    const state = createMockState();
    const seq = tamperAudit(state);
    const result = await reposAs('admin', state).audit.verify({ body: {} });
    expect(result).toMatchObject({ valid: false, first_broken_seq: seq, checked: seq - 1 });
  });
});

describe('approvals', () => {
  it('lists the seeded request waiting for a checker', async () => {
    const repos = reposAs('admin', createMockState());
    const { data } = await repos.approvals.list({ query: { status: 'pending' } });
    expect(data.map((a) => a.id)).toEqual([COOLING_OFF]);
  });

  it('refuses the maker as their own checker', async () => {
    const repos = reposAs('finance', createMockState()); // Tunde made it
    await expect(
      repos.approvals.approve({ path: { approval_id: COOLING_OFF }, idempotencyKey: 'k1' }),
    ).rejects.toSatisfy(is('same_staff'));
  });

  it('applies a config change once approved, and logs approval then change', async () => {
    const state = createMockState();
    const repos = reposAs('admin', state);
    const approved = await repos.approvals.approve({
      path: { approval_id: COOLING_OFF },
      idempotencyKey: 'k1',
    });
    expect(approved).toMatchObject({ status: 'approved', checker: { name: 'Ifeoma Adeyemi' } });
    expect(state.config).toMatchObject({ version: 8, cooling_off: { delay_minutes: 60 } });
    expect(state.audit.slice(-2).map((e) => e.action)).toEqual([
      'approval.approve',
      'config.change.apply',
    ]);

    // A retry returns the first result; a second decision is refused.
    await expect(
      repos.approvals.approve({ path: { approval_id: COOLING_OFF }, idempotencyKey: 'k1' }),
    ).resolves.toMatchObject({ status: 'approved' });
    expect(state.config.version).toBe(8);
    await expect(
      repos.approvals.reject({ path: { approval_id: COOLING_OFF }, body: { reason: 'Too late.' } }),
    ).rejects.toSatisfy(is('conflict'));
  });

  it('unfreezes a customer only after a second person approves', async () => {
    const state = createMockState();
    const request = await reposAs('compliance', state).customers.requestUnfreeze({
      path: { user_id: NGOZI },
      body: { reason: 'Customer confirmed safe on a call.' },
    });
    expect(state.customers.get(NGOZI)!.view.customer.status).toBe('frozen');
    await reposAs('admin', state).approvals.approve({
      path: { approval_id: request.id },
      idempotencyKey: 'k2',
    });
    expect(state.customers.get(NGOZI)!.view.customer.status).toBe('active');
  });

  it('rejects with a reason and changes nothing', async () => {
    const state = createMockState();
    const repos = reposAs('compliance', state);
    const rejected = await repos.approvals.reject({
      path: { approval_id: COOLING_OFF },
      body: { reason: 'Needs the fraud team to agree first.' },
    });
    expect(rejected).toMatchObject({ status: 'rejected', checker: { name: 'Aisha Bello' } });
    expect(state.config.cooling_off.delay_minutes).toBe(30);
  });

  it('expires a request past its deadline', async () => {
    let now = Date.now();
    const state = createMockState(() => now);
    now += 73 * 60 * 60_000;
    const repos = reposAs('admin', state);
    await expect(
      repos.approvals.approve({ path: { approval_id: COOLING_OFF }, idempotencyKey: 'k3' }),
    ).rejects.toSatisfy(is('approval_expired'));
    const { data } = await repos.approvals.list({ query: { status: 'expired' } });
    expect(data.map((a) => a.id)).toContain(COOLING_OFF);
  });

  it('refuses a config change whose section moved on since it was made', async () => {
    const state = createMockState();
    state.config.cooling_off.delay_minutes = 45;
    await expect(
      reposAs('admin', state).approvals.approve({
        path: { approval_id: COOLING_OFF },
        idempotencyKey: 'k4',
      }),
    ).rejects.toSatisfy(is('stale_config'));
  });
});
