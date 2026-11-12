import type { Dispatcher } from '../dispatch';
import { repositoriesFromDispatcher } from '../dispatch';
import type { Repositories } from '../repositories';
import { createHttpClient, type DeviceSigner, type RequestInput, type TokenStore } from './client';

export interface HttpConfig {
  baseUrl: string;
  /** Where bearer tokens live; the session store in the app. */
  tokens?: TokenStore;
  /** Signs money-moving requests with the device key. */
  signer?: DeviceSigner;
  fetch?: typeof fetch;
}

/**
 * Repositories backed by the Go API (T31.1). Every repository call becomes one
 * request through the http client: the bearer token (refreshed ahead of expiry
 * and once on a 401), request ID, idempotency key and step-up token from the
 * input, and the device signature on signed operations. Files are encoded as
 * multipart; failures arrive as ApiError, exactly as the mock bank throws them.
 */
export function createHttpRepositories(config: HttpConfig): Repositories {
  const client = createHttpClient(config);
  const dispatch: Dispatcher = ({ operationId, input, options }) =>
    client.request(operationId, (input ?? {}) as RequestInput, options);
  return repositoriesFromDispatcher(dispatch);
}

export {
  buildPath,
  buildQuery,
  createHttpClient,
  toApiError,
  type DeviceSignature,
  type DeviceSigner,
  type HttpClient,
  type HttpClientConfig,
  type RequestInput,
  type SigningRequest,
  type TokenStore,
  type Tokens,
} from './client';
export { sessionTokens } from './sessionTokens';
