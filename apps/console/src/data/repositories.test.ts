import { OPERATIONS } from '@nem/contracts';
import { describe, expect, it } from 'vitest';

import { isApiError } from './errors';
import { createMockDispatcher } from './mock';
import { switchDemoRole } from './mock/auth';
import { createMockState } from './mock/state';
import { DOMAINS, REPOSITORY_METHODS, repositoriesFromDispatcher } from './repositories';

describe('console repositories', () => {
  it('maps only to staff and developer operations that exist in the contract', () => {
    for (const domain of DOMAINS) {
      const prefix =
        domain === 'developer'
          ? '/v1/developer/'
          : domain === 'developerAuth'
            ? '/v1/auth/'
            : '/v1/admin/';
      for (const operationId of Object.values(REPOSITORY_METHODS[domain])) {
        const meta = OPERATIONS[operationId as keyof typeof OPERATIONS];
        expect(meta, operationId).toBeDefined();
        expect(meta.path.startsWith(prefix), operationId).toBe(true);
      }
    }
  });

  it('reports operations the demo does not cover yet as a 501 problem', async () => {
    const state = createMockState();
    const { access_token } = switchDemoRole(state, 'admin');
    const repos = repositoriesFromDispatcher(
      createMockDispatcher({ latencyMs: 0, state, getAccessToken: () => access_token }),
    );
    await expect(
      repos.customers.requestLimitOverride({
        path: { user_id: 'any' },
        body: {
          daily_limit: { amount_minor: '100', currency: 'NGN' },
          expires_at: '2030-01-01T00:00:00Z',
          reason: 'Not mocked yet.',
        },
      }),
    ).rejects.toSatisfy((e) => isApiError(e, 'not_implemented'));
  });
});
