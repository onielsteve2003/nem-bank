import type { StaffRole } from '@nem/contracts';
import { describe, expect, it } from 'vitest';

import { isApiError } from '../errors';
import { repositoriesFromDispatcher } from '../repositories';
import { switchDemoRole } from './auth';
import { customerId } from './customerSeed';
import { createMockDispatcher } from './index';
import { createMockState } from './state';

function reposAs(role: StaffRole) {
  const state = createMockState(() => Date.parse('2026-11-03T10:00:00Z'));
  const { access_token } = switchDemoRole(state, role);
  const repos = repositoriesFromDispatcher(
    createMockDispatcher({ latencyMs: 0, state, getAccessToken: () => access_token }),
  );
  return { state, repos };
}

const ADAEZE = customerId(1);
const NGOZI = customerId(5);

describe('mock customers', () => {
  it('finds customers by name, @nemtag, phone in any format and account number', async () => {
    const { repos } = reposAs('support');
    const names = async (q: string) =>
      (await repos.customers.search({ query: { q } })).data.map((c) => c.name);

    expect(await names('adaeze')).toEqual(['Adaeze Okonkwo']);
    expect(await names('@tolu')).toEqual(['Tolulope Ajayi']);
    expect(await names('0803 123 4821')).toEqual(['Adaeze Okonkwo']);
    expect(await names('+2348031234821')).toEqual(['Adaeze Okonkwo']);
    expect(await names('9001234821')).toEqual(['Adaeze Okonkwo']);
    expect(await names('zzz')).toEqual([]);
    await expect(repos.customers.search({ query: { q: 'a' } })).rejects.toSatisfy((e) =>
      isApiError(e, 'validation_failed'),
    );
  });

  it('pages results with a cursor', async () => {
    const { repos } = reposAs('support');
    const first = await repos.customers.search({ query: { q: 'gmail', limit: 3 } });
    expect(first.data).toHaveLength(3);
    const second = await repos.customers.search({
      query: { q: 'gmail', limit: 3, cursor: first.page.next_cursor! },
    });
    expect(second.data[0]!.user_id).not.toBe(first.data[0]!.user_id);
  });

  it('hides the date of birth from support and never returns unmasked contact details', async () => {
    const support = await reposAs('support').repos.customers.get({ path: { user_id: ADAEZE } });
    expect(support.date_of_birth).toBeNull();
    expect(support.customer.email_masked).toBe('ad***@gmail.com');
    expect(JSON.stringify(support)).not.toContain('adaeze.okonkwo@gmail.com');

    const compliance = await reposAs('compliance').repos.customers.get({
      path: { user_id: ADAEZE },
    });
    expect(compliance.date_of_birth).toBe('1991-04-12');
  });

  it('freezes at once, and an unfreeze becomes a pending approval for a second person', async () => {
    const { repos, state } = reposAs('compliance');
    const frozen = await repos.customers.freeze({
      path: { user_id: ADAEZE },
      body: { reason: 'Customer reported a stolen phone' },
    });
    expect(frozen.customer.status).toBe('frozen');
    expect(frozen.accounts.every((a) => a.status === 'frozen')).toBe(true);
    expect(frozen.notes[0]!.body).toContain('stolen phone');
    await expect(
      repos.customers.freeze({ path: { user_id: ADAEZE }, body: { reason: 'Again please' } }),
    ).rejects.toSatisfy((e) => isApiError(e, 'conflict'));

    const approval = await repos.customers.requestUnfreeze({
      path: { user_id: ADAEZE },
      body: { reason: 'Customer verified on a call' },
    });
    expect(approval).toMatchObject({ action: 'customer_unfreeze', status: 'pending' });
    expect(approval.maker.name).toBe('Aisha Bello');
    expect(state.customers.get(ADAEZE)!.view.customer.status).toBe('frozen');
    await expect(
      repos.customers.requestUnfreeze({
        path: { user_id: ADAEZE },
        body: { reason: 'Second request' },
      }),
    ).rejects.toSatisfy((e) => isApiError(e, 'approval_pending'));
  });

  it('refuses a freeze from support and a reason that is too short', async () => {
    await expect(
      reposAs('support').repos.customers.freeze({
        path: { user_id: ADAEZE },
        body: { reason: 'Suspicious login' },
      }),
    ).rejects.toSatisfy((e) => isApiError(e, 'forbidden'));
    await expect(
      reposAs('admin').repos.customers.requestUnfreeze({
        path: { user_id: NGOZI },
        body: { reason: 'ok' },
      }),
    ).rejects.toSatisfy((e) => isApiError(e, 'validation_failed'));
  });

  it('adds notes newest first with the author', async () => {
    const { repos } = reposAs('support');
    await repos.customers.addNote({ path: { user_id: NGOZI }, body: { body: 'Called back.' } });
    const view = await repos.customers.get({ path: { user_id: NGOZI } });
    expect(view.notes[0]).toMatchObject({ body: 'Called back.', author: { name: 'Chidi Eze' } });
  });
});
