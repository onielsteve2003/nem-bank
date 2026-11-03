import { OPERATIONS } from '@nem/contracts';
import { describe, expect, it } from 'vitest';

import { isApiError } from './errors';
import { createMockDispatcher } from './mock';
import { createMockState } from './mock/state';
import { DOMAINS, REPOSITORY_METHODS, repositoriesFromDispatcher } from './repositories';

describe('console repositories', () => {
  it('maps only to staff operations that exist in the contract', () => {
    for (const domain of DOMAINS) {
      for (const operationId of Object.values(REPOSITORY_METHODS[domain])) {
        const meta = OPERATIONS[operationId as keyof typeof OPERATIONS];
        expect(meta, operationId).toBeDefined();
        expect(meta.path.startsWith('/v1/admin/'), operationId).toBe(true);
      }
    }
  });

  it('routes a call through the mock to the signed-in staff member', async () => {
    const repos = repositoriesFromDispatcher(createMockDispatcher({ latencyMs: 0 }));
    const me = await repos.auth.me();
    expect(me.roles).toContain('admin');
  });

  it('answers 401 without a session', async () => {
    const state = { ...createMockState(), session: null };
    const repos = repositoriesFromDispatcher(createMockDispatcher({ latencyMs: 0, state }));
    await expect(repos.auth.me()).rejects.toSatisfy((e) => isApiError(e, 'unauthorized'));
  });

  it('reports operations the demo does not cover yet as a 501 problem', async () => {
    const repos = repositoriesFromDispatcher(createMockDispatcher({ latencyMs: 0 }));
    await expect(repos.config.get()).rejects.toSatisfy((e) => isApiError(e, 'not_implemented'));
  });
});
