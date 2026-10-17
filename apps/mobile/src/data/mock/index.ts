import type { Dispatcher } from '../dispatch';
import { repositoriesFromDispatcher } from '../dispatch';
import { problem } from '../errors';
import type { Repositories } from '../repositories';

/**
 * Repositories backed by the on-device mock bank. Domains are filled in on top of
 * the mock ledger (T3.7); anything not yet built fails with a clear problem.
 */
export function createMockRepositories(overrides: Partial<Repositories> = {}): Repositories {
  const dispatch: Dispatcher = ({ operationId }) =>
    Promise.reject(
      problem(501, 'not_implemented', 'Not in the mock bank yet', {
        detail: `${operationId} has no mock implementation yet.`,
      }),
    );
  return repositoriesFromDispatcher(dispatch, overrides);
}
