import {
  OPERATIONS,
  type OperationId,
  type OperationInput,
  type RouteOperationId,
  type Staff,
} from '@nem/contracts';

import { canCall } from '@/features/auth/access';

import { problem } from '../errors';
import type { Dispatcher } from '../repositories';
import { authHandlers } from './auth';
import { dashboardHandlers } from './dashboard';
import type { Handler, Handlers } from './handlers';
import { createMockState, type MockState } from './state';

export type { Handler, Handlers, MockContext } from './handlers';

const HANDLERS: Handlers = { ...authHandlers, ...dashboardHandlers };

export interface MockOptions {
  /** Simulated network latency so loading states are real (0 in tests). */
  latencyMs?: number;
  state?: MockState;
  /** Supplies the bearer token, like the http client's auth header. */
  getAccessToken?: () => string | null;
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

function staffFor(state: MockState, token: string | null): Staff | null {
  const id = token ? state.sessions.get(token) : undefined;
  return (id && state.accounts.get(id)?.staff) || null;
}

export function createMockDispatcher({
  latencyMs = 250,
  state = createMockState(),
  getAccessToken = () => null,
}: MockOptions = {}): Dispatcher {
  return async ({ operationId, input, options }) => {
    await wait(latencyMs, options?.signal);
    const token = getAccessToken();
    const staff = staffFor(state, token);

    // The same checks the API's staffAuth middleware makes, in the same order.
    const meta = OPERATIONS[operationId as RouteOperationId];
    if (meta?.auth === 'staff') {
      if (!staff) throw problem(401, 'unauthorized', 'Sign in again');
      if ('roles' in meta && !canCall(staff.roles, operationId as RouteOperationId)) {
        throw problem(403, 'forbidden', 'Your role cannot do this');
      }
    }

    const handler = HANDLERS[operationId] as Handler<OperationId> | undefined;
    if (!handler) {
      throw problem(501, 'not_implemented', 'Not available in the demo yet', {
        detail: `${operationId} has no mock handler.`,
      });
    }
    return handler(input as OperationInput<OperationId>, { state, token, staff });
  };
}
