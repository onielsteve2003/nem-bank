import type { OperationId, OperationInput, OperationOutput } from '@nem/contracts';

import { problem } from '../errors';
import type { Dispatcher } from '../repositories';
import { createMockState, type MockState } from './state';

export interface MockContext {
  state: MockState;
}

export type Handler<K extends OperationId> = (
  input: OperationInput<K>,
  ctx: MockContext,
) => OperationOutput<K> | Promise<OperationOutput<K>>;

export type Handlers = { [K in OperationId]?: Handler<K> };

const HANDLERS: Handlers = {
  getStaffMe: (_input, { state }) => {
    if (!state.session) throw problem(401, 'unauthorized', 'Sign in again');
    return state.session;
  },
};

export interface MockOptions {
  /** Simulated network latency so loading states are real (0 in tests). */
  latencyMs?: number;
  state?: MockState;
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

export function createMockDispatcher({
  latencyMs = 250,
  state = createMockState(),
}: MockOptions = {}): Dispatcher {
  return async ({ operationId, input, options }) => {
    await wait(latencyMs, options?.signal);
    const handler = HANDLERS[operationId] as Handler<OperationId> | undefined;
    if (!handler) {
      throw problem(501, 'not_implemented', 'Not available in the demo yet', {
        detail: `${operationId} has no mock handler.`,
      });
    }
    return handler(input as OperationInput<OperationId>, { state });
  };
}
