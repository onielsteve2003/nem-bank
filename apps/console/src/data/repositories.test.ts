import { OPERATIONS } from '@nem/contracts';
import { describe, expect, it } from 'vitest';

import { isApiError } from './errors';
import { createMockDispatcher } from './mock';
import { switchDemoRole } from './mock/auth';
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

  it('reports operations the demo does not cover yet as a 501 problem', async () => {
    const state = createMockState();
    const { access_token } = switchDemoRole(state, 'admin');
    const repos = repositoriesFromDispatcher(
      createMockDispatcher({ latencyMs: 0, state, getAccessToken: () => access_token }),
    );
    await expect(repos.config.get()).rejects.toSatisfy((e) => isApiError(e, 'not_implemented'));
  });
});
