import type { Dispatcher } from '../dispatch';
import { problem } from '../errors';
import { repositoriesFromDispatcher } from '../dispatch';
import type { Repositories } from '../repositories';

export interface HttpConfig {
  baseUrl: string;
}

/**
 * Repositories backed by the Go API. Phase 2 (M31) routes each operation through
 * the http client (T3.11); until then every call fails with a clear problem.
 */
export function createHttpRepositories(config: HttpConfig): Repositories {
  const dispatch: Dispatcher = ({ operationId }) =>
    Promise.reject(
      problem(501, 'not_implemented', 'Not available yet', {
        detail: `${operationId} on ${config.baseUrl} is wired up in Phase 2. Use EXPO_PUBLIC_API_MODE=mock.`,
      }),
    );
  return repositoriesFromDispatcher(dispatch);
}
